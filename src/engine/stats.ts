import { MetricStats } from './baseline-store';

/**
 * Descriptive statistics for a raw value series.
 *
 * Deliberately duplicated from `alerts/baselines.service.ts` rather than
 * imported, so the scoring module stays free of Prisma/Nest dependencies.
 * `surprise.spec.ts` pins the output to keep the two implementations
 * numerically identical.
 */
export function computeStats(values: number[]): MetricStats {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length === 0) {
    return { mean: 0, stdDev: 0, p50: 0, p90: 0, p95: 0, byDayOfWeek: {}, n: 0 };
  }
  clean.sort((a, b) => a - b);
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const variance =
    clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length;
  const stdDev = Math.sqrt(variance);
  const pct = (p: number) => {
    const idx = Math.min(clean.length - 1, Math.floor(p * clean.length));
    return clean[idx];
  };
  return {
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    p50: pct(0.5),
    p90: pct(0.9),
    p95: pct(0.95),
    byDayOfWeek: {},
    n: clean.length,
  };
}

/**
 * Average value per weekday over a date range, e.g. {0: 1.5, 1: 2.3, ...}.
 * Divides by how many times each weekday actually occurred in the window
 * rather than by a flat divisor.
 */
export function weekdayAverages(
  rows: { date: Date }[],
  since: Date,
  now: Date,
): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const r of rows) {
    counts[r.date.getDay()] = (counts[r.date.getDay()] ?? 0) + 1;
  }
  const occurrences: Record<number, number> = {};
  const cursor = new Date(since);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= now) {
    occurrences[cursor.getDay()] = (occurrences[cursor.getDay()] ?? 0) + 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  const result: Record<number, number> = {};
  for (const dow of Object.keys(counts)) {
    const d = Number(dow);
    const occ = occurrences[d] ?? 1;
    result[d] = Math.round((counts[d] / occ) * 100) / 100;
  }
  return result;
}
