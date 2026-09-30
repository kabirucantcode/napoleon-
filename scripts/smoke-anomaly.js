'use strict';

/**
 * Anomaly scoring smoke test.
 *
 * Covers the copied scoring engine (`stats`, `surprise`) and the `/analyze`
 * controller's validation, none of which needs a database — the caller supplies
 * the history.
 *
 *   node scripts/smoke-anomaly.js
 */

const { boot, check, summary, requireDist } = require('./_harness');

const { computeStats, weekdayAverages } = requireDist('engine/stats');
const { scoreAgainst, resolveSeverity } = requireDist('engine/surprise');
const { AnalyzeController } = requireDist('modules/analyze.controller');

/** Runs a controller call and reports the HTTP status it threw, if any. */
function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, status: err.getStatus?.(), message: err.message };
  }
}

function main() {
  // ── Descriptive statistics ────────────────────────────────────────────────
  boot('computeStats');
  const s = computeStats([1, 2, 3, 4, 5]);
  check('mean', s.mean === 3, s.mean);
  check('population standard deviation', s.stdDev === 1.41, s.stdDev);
  check('p50 is the median', s.p50 === 3, s.p50);
  check('p90', s.p90 === 5, s.p90);
  check('sample size is retained', s.n === 5, s.n);

  const dirty = computeStats([10, -5, NaN, Infinity, 20]);
  check('negatives and non-finite values are dropped', dirty.n === 2, dirty.n);
  check('the mean reflects only valid values', dirty.mean === 15, dirty.mean);

  const empty = computeStats([]);
  check('an empty series yields zero-valued stats', empty.n === 0 && empty.mean === 0);

  const constant = computeStats([7, 7, 7]);
  check('a constant series has no spread', constant.stdDev === 0);

  // ── Weekday profile ───────────────────────────────────────────────────────
  boot('weekdayAverages');
  const since = new Date('2026-09-01T00:00:00');
  const now = new Date('2026-09-14T23:59:59'); // 14 days -> each weekday twice
  const dayA = new Date('2026-09-01T09:00:00');
  const dayB = new Date('2026-09-02T09:00:00');
  const rows = [
    { date: dayA },
    { date: new Date('2026-09-08T09:00:00') }, // same weekday as dayA
    { date: dayB },
    { date: new Date('2026-09-09T09:00:00') }, // same weekday as dayB
    { date: new Date('2026-09-09T21:00:00') },
    { date: new Date('2026-09-09T23:00:00') },
  ];
  const profile = weekdayAverages(rows, since, now);
  check('two rows across two occurrences averages to 1', profile[dayA.getDay()] === 1, profile[dayA.getDay()]);
  check('four rows across two occurrences averages to 2', profile[dayB.getDay()] === 2, profile[dayB.getDay()]);

  // ── Surprise scoring ─────────────────────────────────────────────────────
  boot('scoreAgainst');
  const cold = scoreAgainst({ metric: 'm', value: 5, stats: null, series: [] });
  check('no stats means a cold start', cold.coldStart === true);
  check('a cold start sits at 0.5, not 0 or 1', cold.surprise === 0.5, cold.surprise);
  check('no prior is claimed when none was passed', cold.priorApplied === false);

  const nudged = scoreAgainst({ metric: 'm', value: 5, stats: computeStats([]), series: [] });
  check('an empty history is flagged cold', nudged.coldStart === true);
  check('an empty history also sits at 0.5', nudged.surprise === 0.5, nudged.surprise);

  const history = [8, 9, 10, 11, 12];
  const stats = computeStats(history);

  const typical = scoreAgainst({ metric: 'm', value: 10, stats, series: history });
  check('the mean scores below the warning threshold', typical.surprise < 0.9, typical.surprise);
  check('the mean is not treated as anomalous', resolveSeverity(typical.surprise) === 'INFO');

  const extreme = scoreAgainst({ metric: 'm', value: 50, stats, series: history });
  check('a far-out value saturates the score', extreme.surprise === 1, extreme.surprise);
  check('a far-out value is CRITICAL', resolveSeverity(extreme.surprise) === 'CRITICAL');
  check('the percentile is 1 above the whole history', extreme.percentile === 1);

  const step1 = scoreAgainst({ metric: 'm', value: 11, stats, series: history });
  const step2 = scoreAgainst({ metric: 'm', value: 12, stats, series: history });
  check(
    'the score is monotonic in the value',
    step1.surprise <= step2.surprise && step2.surprise <= extreme.surprise,
    `${step1.surprise} / ${step2.surprise} / ${extreme.surprise}`,
  );

  const below = scoreAgainst({ metric: 'm', value: 1, stats, series: history });
  check('a value below all history is not flagged', resolveSeverity(below.surprise) === 'INFO');

  // Prior shrinkage: a two-sample history must not be trusted at face value.
  boot('prior shrinkage');
  const thin = computeStats([100, 100]);
  const withoutPrior = scoreAgainst({ metric: 'm', value: 100, stats: thin, series: [100, 100] });
  const withPrior = scoreAgainst({
    metric: 'm',
    value: 100,
    stats: thin,
    series: [100, 100],
    prior: { mean: 10, stdDev: 2 },
  });
  check('without a prior the baseline is the raw mean', withoutPrior.baselineMean === 100, withoutPrior.baselineMean);
  check('a prior pulls a thin baseline toward it', withPrior.baselineMean < 40, withPrior.baselineMean);
  check('the blended baseline sits above the prior itself', withPrior.baselineMean > 10);
  check('blending widens the spread, so confidence is not faked', withPrior.stdDev > withoutPrior.stdDev);
  check('the prior is reported as applied', withPrior.priorApplied === true);

  const longHistory = Array.from({ length: 200 }, (_, i) => 100 + (i % 3));
  const strong = scoreAgainst({
    metric: 'm',
    value: 100,
    stats: computeStats(longHistory),
    series: longHistory,
    prior: { mean: 10, stdDev: 2 },
  });
  check('a long history resists the prior', strong.baselineMean > 95, strong.baselineMean);

  // Weekday awareness.
  boot('weekday awareness');
  const monday = new Date('2026-09-15T10:00:00');
  const weekdayStats = {
    ...computeStats([1, 1, 1]),
    mean: 50,
    stdDev: 1,
    byDayOfWeek: { [monday.getDay()]: 1 },
  };
  const weekdayScored = scoreAgainst({
    metric: 'm',
    value: 5,
    stats: weekdayStats,
    series: [1, 1, 1],
    date: monday,
  });
  check('the weekday mean is used for comparison', weekdayScored.weekdayMean === 1, weekdayScored.weekdayMean);
  check('the global mean is still reported', weekdayScored.baselineMean === 50, weekdayScored.baselineMean);

  // ── Severity ladder ───────────────────────────────────────────────────────
  boot('resolveSeverity');
  check('0.5 is INFO', resolveSeverity(0.5) === 'INFO');
  check('0.9 is WARNING', resolveSeverity(0.9) === 'WARNING');
  check('0.99 is CRITICAL', resolveSeverity(0.99) === 'CRITICAL');
  check(
    'custom thresholds are honoured',
    resolveSeverity(0.7, { warning: 0.6, critical: 0.8 }) === 'WARNING',
  );

  // ── /analyze controller ───────────────────────────────────────────────────
  boot('POST /analyze');
  const controller = new AnalyzeController();
  const principal = {};

  const good = attempt(() =>
    controller.analyze(principal, {
      metric: 'failed_logins',
      value: 42,
      history: [1, 2, 3, 4, 5],
      entityId: 'gateway-7',
    }),
  );
  check('a valid request is scored', good.ok === true && good.value.surprise > 0.9, good.message);
  check('the entity id is echoed back', good.value?.entityId === 'gateway-7');
  check('a severity is attached', good.value?.severity === 'CRITICAL');

  const noMetric = attempt(() => controller.analyze(principal, { value: 1, history: [] }));
  check('a missing metric is rejected', noMetric.status === 400, noMetric.status);

  const badValue = attempt(() =>
    controller.analyze(principal, { metric: 'm', value: 'ten', history: [] }),
  );
  check('a non-numeric value is rejected', badValue.status === 400, badValue.status);

  const badHistory = attempt(() =>
    controller.analyze(principal, { metric: 'm', value: 1, history: 'nope' }),
  );
  check('a non-array history is rejected', badHistory.status === 400, badHistory.status);

  const badEntry = attempt(() =>
    controller.analyze(principal, { metric: 'm', value: 1, history: [1, 'two'] }),
  );
  check('a non-numeric history entry is rejected', badEntry.status === 400, badEntry.status);

  const tolerated = attempt(() =>
    controller.analyze(principal, {
      metric: 'm',
      value: 1,
      history: [1],
      temperature: 0.7,
      unknownField: { nested: true },
    }),
  );
  check('unknown fields are ignored, not rejected', tolerated.ok === true, tolerated.message);

  const batch = controller.batch({
    items: [
      { metric: 'a', value: 10, history: [8, 9, 10, 11, 12] },
      { metric: 'b', value: 'invalid', history: [] },
      { metric: 'c', value: 100, history: [8, 9, 10, 11, 12] },
    ],
  });
  check('a batch returns one result per item', batch.results.length === 3);
  check('a bad item is reported in place', typeof batch.results[1].error === 'string');
  check('a bad item does not discard its neighbours', batch.results[2].surprise === 1);

  const batchBad = attempt(() => controller.batch({ items: 'nope' }));
  check('a non-array batch is rejected', batchBad.status === 400, batchBad.status);

  const tooBig = attempt(() => controller.batch({ items: new Array(1001).fill({}) }));
  check('an oversized batch is rejected', tooBig.status === 400, tooBig.status);

  summary();
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
