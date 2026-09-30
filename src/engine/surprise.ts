import { MetricStats, Prior } from './baseline-store';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface SurpriseResult {
  metric: string;
  value: number;
  /** Mean the value was compared against (post-shrinkage). */
  baselineMean: number;
  stdDev: number;
  zScore: number;
  zLogistic: number;
  /** 0..1 — empirical: fraction of historical values <= today's. */
  percentile: number;
  /** 0..1 combined score — max of the z-score logistic and the percentile. */
  surprise: number;
  /** Mean actually used for the logistic, when a weekday profile exists. */
  weekdayMean: number | null;
  /** Samples behind the baseline. */
  sampleSize: number;
  /** True when there is too little history to score against. */
  coldStart: boolean;
  priorApplied: boolean;
}

export interface ScoreThresholds {
  warning: number;
  critical: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = {
  warning: 0.9,
  critical: 0.99,
};

export const DEFAULT_PRIOR_STRENGTH = 7;

export interface ScoreInput {
  metric: string;
  value: number;
  stats: MetricStats | null | undefined;
  series: number[];
  date?: Date;
  prior?: Prior;
  priorStrength?: number;
}

/**
 * Blend a thin entity history toward a cross-tenant prior so a brand new
 * tenant scores against something instead of returning 0.5 forever.
 *
 * Weight is n/(n+k): a long history ignores the prior, a short one leans on
 * it. Variance uses the full pooled form, so a mean far from the prior
 * widens the spread rather than producing a falsely confident z-score.
 * This is an approximate empirical-Bayes blend, not a fitted model.
 */
function applyPrior(
  stats: MetricStats,
  prior: Prior,
  strength: number,
  sampleSize: number,
): MetricStats {
  const w = sampleSize / (sampleSize + strength);
  const mean = w * stats.mean + (1 - w) * prior.mean;
  const variance =
    w * stats.stdDev ** 2 +
    (1 - w) * prior.stdDev ** 2 +
    w * (1 - w) * (stats.mean - prior.mean) ** 2;
  return {
    ...stats,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(Math.sqrt(Math.max(variance, 0)) * 100) / 100,
    n: sampleSize,
  };
}

/**
 * Score a single metric value against an entity's usual behaviour.
 *
 * Two signals are combined:
 *  1. z-score -> logistic: 1 / (1 + e^-z), where the mean is day-of-week
 *     aware (Mondays are busier than Saturdays).
 *  2. percentile rank: where the value sits in the historical distribution
 *     (a simple empirical density model).
 *
 * surprise = max(zLogistic, percentile) — robust to either signal being
 * degenerate, e.g. no spread yet means the z is undefined while the
 * percentile still works.
 *
 * Pure function: no I/O, no clock beyond the optional `date`, so it can be
 * exercised directly in tests and reused by any caller.
 *
 * NOTE: the reported `zScore` is measured against the global mean while the
 * logistic uses the weekday mean. That asymmetry is inherited from
 * `alerts/surprise.service.ts` and is pinned by the parity tests; fixing it
 * is a behaviour change to the existing alerting path and is not done here.
 */
export function scoreAgainst(input: ScoreInput): SurpriseResult {
  const { metric, value, series, date, prior } = input;
  const sampleSize = input.stats?.n ?? series.length;

  if (!input.stats) {
    return {
      metric,
      value,
      baselineMean: 0,
      stdDev: 0,
      zScore: 0,
      zLogistic: 0.5,
      percentile: 0.5,
      surprise: 0.5,
      weekdayMean: null,
      sampleSize,
      coldStart: true,
      priorApplied: false,
    };
  }

  const strength = input.priorStrength ?? DEFAULT_PRIOR_STRENGTH;
  const usePrior = prior !== undefined && strength > 0;
  const stats = usePrior
    ? applyPrior(input.stats, prior, strength, sampleSize)
    : input.stats;

  let zLogistic = 0.5;
  let weekdayMean: number | null = null;
  if (stats.stdDev > 0) {
    const dow = (date ?? new Date()).getDay();
    const dowMean = stats.byDayOfWeek?.[dow];
    weekdayMean =
      dowMean !== undefined && dowMean !== null ? dowMean : stats.mean;
    zLogistic = 1 / (1 + Math.exp(-(value - weekdayMean) / stats.stdDev));
  }

  const n = series.length;
  const percentile =
    n > 0 ? (series.filter((v) => v <= value).length + 1) / (n + 1) : 0.5;

  return {
    metric,
    value,
    baselineMean: Math.round(stats.mean * 100) / 100,
    stdDev: stats.stdDev,
    zScore:
      Math.round(
        ((value - stats.mean) / Math.max(stats.stdDev, 0.0001)) * 100,
      ) / 100,
    zLogistic: Math.round(zLogistic * 1000) / 1000,
    percentile: Math.round(percentile * 1000) / 1000,
    surprise: Math.round(Math.max(zLogistic, percentile) * 1000) / 1000,
    weekdayMean:
      weekdayMean === null ? null : Math.round(weekdayMean * 100) / 100,
    sampleSize,
    coldStart: sampleSize === 0,
    priorApplied: usePrior,
  };
}

/** Map a surprise score onto the alert severity ladder. */
export function resolveSeverity(
  surprise: number,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): Severity {
  if (surprise >= thresholds.critical) return 'CRITICAL';
  if (surprise >= thresholds.warning) return 'WARNING';
  return 'INFO';
}
