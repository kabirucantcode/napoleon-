/**
 * Storage port for the anomaly scoring engine.
 *
 * The scorer is deliberately unaware of where numbers come from. Anything
 * that can answer "what is this entity's usual behaviour for this metric"
 * satisfies this interface: the in-memory store used for stateless scoring,
 * a Prisma-backed store for ingested tenant data, or an adapter over the
 * existing Spectra `BaselinesService`.
 *
 * This decouples the engine from Spectra's domain model, which is what makes
 * the scorer reusable by other security applications.
 */

export interface MetricStats {
  mean: number;
  stdDev: number;
  p50: number;
  p90: number;
  p95: number;
  /** Average events per weekday: 0=Sun .. 6=Sat */
  byDayOfWeek: Record<number, number>;
  /** Samples behind these stats. Drives prior shrinkage on a cold start. */
  n?: number;
}

export interface BaselineQuery {
  tenantId: string;
  entityId: string;
  windowDays?: number;
}

export interface BaselineStore {
  /** Descriptive stats for the entity/metric, or null when no history exists. */
  getStats(query: BaselineQuery, metric: string): Promise<MetricStats | null>;
  /** Raw historical values, oldest first, excluding the current value. */
  getSeries(query: BaselineQuery, metric: string): Promise<number[]>;
  /** Metrics this entity has history for. */
  listMetrics(query: BaselineQuery): Promise<string[]>;

  /** Replace stored history. Optional: read-only stores need not implement it. */
  putSeries?(
    query: BaselineQuery,
    metric: string,
    values: number[],
  ): Promise<number>;
  /** Append to stored history, trimming the oldest. */
  appendSeries?(
    query: BaselineQuery,
    metric: string,
    values: number[],
  ): Promise<number>;
}

/**
 * Cross-tenant prior blended into a thin history so a new tenant is not
 * blind for the first 30 days. Supplied per request rather than held
 * server-side, because a server-held aggregate leaks other tenants' data.
 */
export interface Prior {
  mean: number;
  stdDev: number;
}

export const BASELINE_STORE = Symbol('BASELINE_STORE');

export const DEFAULT_WINDOW_DAYS = 30;
