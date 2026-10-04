/**
 * Type definitions for the Napoleon client.
 *
 * The chat surface is OpenAI-compatible, so those shapes deliberately mirror the
 * `openai` package. The rest is Napoleon's own API.
 */

// ── Shared ──────────────────────────────────────────────────────────────────

export type DataStatus = 'EMPTY' | 'PARTIAL' | 'OK';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ApiKeyScope = 'ADMIN' | 'READ';

export declare class NapoleonError extends Error {
  name: 'NapoleonError';
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown);
}

// ── Insights ────────────────────────────────────────────────────────────────

export interface Insight {
  severity: string;
  category: string;
  title: string;
  detail: string;
  recommendation: string;
  metric: string;
}

export interface Overview {
  generatedAt: string;
  /**
   * EMPTY  — nothing ingested; no metric is meaningful, healthScore is 0.
   * PARTIAL — some sources have no records; healthScore is computed over the
   *           inputs that exist, so it is not comparable to a full deployment.
   * OK     — every source has data.
   */
  dataStatus: DataStatus;
  healthScore: number;
  openIncidents: number;
  avgGuardPerformance: number;
  lateCheckInRate: number;
  patrolCompletionRate: number;
  atRiskGuardCount: number;
  siteCount: number;
  insights: Insight[];
}

export interface SiteRisk {
  siteId: string;
  siteName: string;
  riskLevel: string;
  riskScore: number;
  incidentCount30d: number;
  openIncidents30d: number;
  lateCheckInRate: number;
  patrolCompletionRate: number;
  peakIncidentHour: number | null;
}

export interface AtRiskGuard {
  guardId: string;
  fullName: string;
  shift: string;
  site: string;
  performanceScore: number;
  reliability: number;
  lateCount: number;
  absentCount: number;
  flaggedCount: number;
  riskLevel: string;
  riskFactors: string[];
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface IncidentMetrics {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  total: number;
  inWindow: number;
  today: number;
  open: number;
  daily: { date: string; count: number }[];
  byType: Record<string, number>;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface ScoreResult {
  metric: string;
  value: number;
  baselineMean: number;
  stdDev: number;
  zScore: number;
  zLogistic: number;
  percentile: number;
  surprise: number;
  weekdayMean: number | null;
  sampleSize: number;
  coldStart: boolean;
  priorApplied: boolean;
  entityId?: string;
  severity: Severity;
}

export interface ScoreInput {
  metric: string;
  value: number;
  history: number[];
  entityId?: string;
  /** Only affects the day-of-week baseline. */
  date?: string;
  /** Blend a thin history toward a known baseline. */
  prior?: { mean: number; stdDev: number };
  priorStrength?: number;
}

// ── Ingest ──────────────────────────────────────────────────────────────────

export interface SiteInput {
  externalId: string;
  name: string;
  riskLevel?: RiskLevel;
}

export interface GuardInput {
  externalId: string;
  fullName: string;
  status?: string;
  performanceScore?: number;
  currentShift?: string;
  siteExternalId?: string | null;
}

export interface IncidentInput {
  externalId: string;
  siteExternalId: string;
  severity: RiskLevel;
  status?: string;
  type?: string | null;
  reportedAt: string | Date;
}

export interface AttendanceInput {
  externalId: string;
  guardExternalId: string;
  siteExternalId: string;
  createdAt?: string | Date;
  isLate?: boolean;
  isAbsent?: boolean;
  status?: string;
}

export interface PatrolRouteInput {
  externalId: string;
  siteExternalId: string;
  name?: string;
}

export interface PatrolRecordInput {
  externalId: string;
  guardExternalId: string;
  routeExternalId: string;
  completionPercentage: number;
  createdAt?: string | Date;
}

export interface UpsertResult {
  upserted?: number;
  routesUpserted?: number;
  recordsUpserted?: number;
}

export interface EraseResult {
  success: boolean;
  deleted: Record<string, number>;
}

// ── Keys ────────────────────────────────────────────────────────────────────

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface IssuedApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  /** Returned exactly once. Only its sha256 is stored. */
  apiKey: string;
  warning: string;
}

// ── OpenAI-compatible surface ───────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string | Array<{ type?: string; text?: string }>;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  napoleon_conversation_id: string | null;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: 'stop' | null;
  }>;
  usage?: Usage;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      /** Additive: the structured payload behind the prose. */
      napoleon: {
        intent: 'overview' | 'risk_by_site' | 'at_risk_guards';
        generatedAt: string;
        analysis: Overview | SiteRisk[] | AtRiskGuard[];
      };
    };
    finish_reason: 'stop';
  }>;
  usage: Usage;
  system_fingerprint: string;
  napoleon_conversation_id: string | null;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  napoleon: { intent: string; description: string };
}

export interface ChatCompletionParams {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  conversation_id?: string;
  /** Accepted and ignored, for OpenAI compatibility. */
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  n?: number;
  stop?: string | string[];
  tools?: unknown[];
  user?: string;
  [key: string]: unknown;
}

export interface ChatCompletions {
  create(
    params: ChatCompletionParams & { stream: true },
  ): Promise<AsyncIterableIterator<ChatCompletionChunk>>;
  create(params: ChatCompletionParams): Promise<ChatCompletion>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export interface Conversation {
  id: string;
  organizationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    intent: string | null;
    tokens: number;
    createdAt: string;
  }>;
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface NapoleonClientOptions {
  /** API root, e.g. https://host/api/v1 */
  baseUrl: string;
  /** sk_napoleon_… Optional only for /models and /health. */
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export declare class NapoleonClient {
  constructor(options: NapoleonClientOptions);

  baseUrl: string;
  apiKey: string;
  timeoutMs: number;

  readonly chat: { completions: ChatCompletions };
  readonly models: { list(): Promise<{ object: 'list'; data: ModelInfo[] }> };
  readonly insights: {
    overview(): Promise<Overview>;
    riskBySite(): Promise<SiteRisk[]>;
    atRiskGuards(): Promise<AtRiskGuard[]>;
  };
  readonly metrics: {
    incidents(query?: {
      days?: number;
      type?: string;
      from?: string;
      to?: string;
    }): Promise<IncidentMetrics>;
  };
  readonly analyze: {
    score(input: ScoreInput): Promise<ScoreResult>;
    batch(items: ScoreInput[]): Promise<{
      results: Array<ScoreResult | { index: number; error: string }>;
    }>;
  };
  readonly keys: {
    create(options: { name: string; scope?: ApiKeyScope }): Promise<IssuedApiKey>;
    list(): Promise<ApiKeySummary[]>;
    revoke(id: string): Promise<{ success: boolean; id: string }>;
  };
  readonly ingest: {
    sites(sites: SiteInput[]): Promise<UpsertResult>;
    guards(guards: GuardInput[]): Promise<UpsertResult>;
    incidents(incidents: IncidentInput[]): Promise<UpsertResult>;
    attendance(attendance: AttendanceInput[]): Promise<UpsertResult>;
    patrols(input?: {
      routes?: PatrolRouteInput[];
      records?: PatrolRecordInput[];
    }): Promise<UpsertResult>;
    eraseData(): Promise<EraseResult>;
  };
  readonly conversations: {
    list(limit?: number): Promise<ConversationSummary[]>;
    get(id: string): Promise<Conversation>;
    remove(id: string): Promise<{ success: boolean }>;
  };

  health(): Promise<{ status: string; service: string; time: string }>;
}

export declare function parseSse(
  res: Response,
): AsyncIterableIterator<ChatCompletionChunk>;
