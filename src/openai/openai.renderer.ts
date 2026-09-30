import { Injectable } from '@nestjs/common';
import { InsightsService } from '../engine/insights.service';

/**
 * The intent a request maps to. Napoleon is deterministic, so "which model"
 * really means "which analysis do you want". These three cover the whole
 * intelligence surface today.
 */
export type NapoleonIntent = 'overview' | 'risk_by_site' | 'at_risk_guards';

export interface NapoleonModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Napoleon-specific metadata (ignored by OpenAI clients). */
  napoleon: { intent: NapoleonIntent; description: string };
}

const MODEL_CATALOG: {
  id: string;
  intent: NapoleonIntent;
  description: string;
}[] = [
  {
    id: 'napoleon-1',
    intent: 'overview',
    description:
      'Organizational health score, KPIs and rule-based insights across incidents, attendance and patrols.',
  },
  {
    id: 'napoleon-pro',
    intent: 'overview',
    description:
      'Same as napoleon-1. Alias kept so clients can pin a "pro" tier name.',
  },
  {
    id: 'napoleon-risk',
    intent: 'risk_by_site',
    description:
      'Per-site risk ranking over the last 30 days with the drivers behind each score.',
  },
  {
    id: 'napoleon-risk-by-site',
    intent: 'risk_by_site',
    description: 'Alias of napoleon-risk.',
  },
  {
    id: 'napoleon-guards',
    intent: 'at_risk_guards',
    description:
      'Guards flagged at risk over the last 14 days with their contributing factors.',
  },
  {
    id: 'napoleon-at-risk-guards',
    intent: 'at_risk_guards',
    description: 'Alias of napoleon-guards.',
  },
];

/** Model names a wrapper might send when the caller did not set one explicitly. */
const DEFAULT_INTENT: NapoleonIntent = 'overview';

const SEVERITY_EMOJI: Record<string, string> = {
  CRITICAL: '🔴',
  HIGH: '🔴',
  WARNING: '🟠',
  MEDIUM: '🟠',
  INFO: '🟢',
  LOW: '🟢',
};

const padHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

export const estimateTokens = (text: string) =>
  Math.max(1, Math.ceil(String(text).length / 4));

/**
 * Renders the engine's deterministic output into the OpenAI chat-completions
 * shape so any OpenAI-compatible client can consume it by swapping `baseURL`.
 *
 * The engine itself knows nothing about HTTP or OpenAI — it returns plain data.
 * All formatting lives here so the wire format can change without touching the
 * rules.
 */
@Injectable()
export class OpenAiRenderer {
  constructor(private readonly engine: InsightsService) {}

  // ── Model registry ───────────────────────────────────────────────────────

  listModels(): { object: 'list'; data: NapoleonModelInfo[] } {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: MODEL_CATALOG.map((m) => ({
        id: m.id,
        object: 'model' as const,
        created,
        owned_by: 'spectra',
        napoleon: { intent: m.intent, description: m.description },
      })),
    };
  }

  /** The catalog plus the generic OpenAI names wrappers fall back to. */
  supportedModelIds(): string[] {
    return [
      ...MODEL_CATALOG.map((m) => m.id),
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
    ];
  }

  /**
   * Decide which analysis the caller wants. Explicit Napoleon model names win;
   * a generic OpenAI model name is treated as a hint from the wrapper, so we
   * fall back to reading the actual question.
   */
  resolveIntent(model: string, prompt: string): NapoleonIntent {
    const m = (model || '').toLowerCase();

    const exact = MODEL_CATALOG.find((c) => c.id === m);
    if (exact) return exact.intent;

    if (m.includes('risk') || m.includes('hotspot')) return 'risk_by_site';
    if (
      m.includes('guard') ||
      m.includes('officer') ||
      m.includes('personnel') ||
      m.includes('staff')
    ) {
      return 'at_risk_guards';
    }
    if (m.startsWith('napoleon')) return DEFAULT_INTENT;

    return this.inferIntentFromPrompt(prompt);
  }

  private inferIntentFromPrompt(prompt: string): NapoleonIntent {
    const p = (prompt || '').toLowerCase();
    if (
      /\b(risk|risky|dangerous|worst|hotspot|hot spot|per site|by site|which sites?)\b/.test(
        p,
      )
    ) {
      return 'risk_by_site';
    }
    if (
      /\b(guards?|officers?|personnel|staff|who is|underperform|rideshare review)\b/.test(
        p,
      )
    ) {
      return 'at_risk_guards';
    }
    return DEFAULT_INTENT;
  }

  // ── Engine dispatch ──────────────────────────────────────────────────────

  async analyze(organizationId: string, intent: NapoleonIntent) {
    switch (intent) {
      case 'risk_by_site':
        return this.engine.getRiskBySite(organizationId);
      case 'at_risk_guards':
        return this.engine.getAtRiskGuards(organizationId);
      case 'overview':
      default:
        return this.engine.getOverview(organizationId);
    }
  }

  // ── Markdown rendering ───────────────────────────────────────────────────

  render(intent: NapoleonIntent, data: unknown): string {
    switch (intent) {
      case 'risk_by_site':
        return this.renderRiskBySite(data as Awaited<
          ReturnType<InsightsService['getRiskBySite']>
        >);
      case 'at_risk_guards':
        return this.renderAtRiskGuards(data as Awaited<
          ReturnType<InsightsService['getAtRiskGuards']>
        >);
      case 'overview':
      default:
        return this.renderOverview(
          data as Awaited<ReturnType<InsightsService['getOverview']>>,
        );
    }
  }

  private renderOverview(
    o: Awaited<ReturnType<InsightsService['getOverview']>>,
  ): string {
    const lines: string[] = [];
    lines.push(`## Operational health: ${o.healthScore}/100`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Open incidents (30d) | ${o.openIncidents} |`);
    lines.push(`| Avg guard performance | ${o.avgGuardPerformance} |`);
    lines.push(`| Late check-in rate | ${o.lateCheckInRate}% |`);
    lines.push(`| Patrol completion | ${o.patrolCompletionRate}% |`);
    lines.push(`| Guards at risk | ${o.atRiskGuardCount} |`);
    lines.push(`| Sites monitored | ${o.siteCount} |`);
    lines.push('');
    lines.push('### Insights');
    lines.push('');
    for (const i of o.insights) {
      const emoji = SEVERITY_EMOJI[i.severity] ?? '•';
      lines.push(
        `${emoji} **${i.title}** _(${i.category} · ${i.metric})_`,
      );
      lines.push(`${i.detail}`);
      lines.push(`→ ${i.recommendation}`);
      lines.push('');
    }
    lines.push(this.footer(o.generatedAt));
    return lines.join('\n');
  }

  private renderRiskBySite(
    sites: Awaited<ReturnType<InsightsService['getRiskBySite']>>,
  ): string {
    const lines: string[] = [];
    lines.push('## Site risk ranking');
    lines.push('');
    if (sites.length === 0) {
      lines.push('No sites are registered for this organization yet.');
      lines.push('');
      lines.push(this.footer(new Date().toISOString()));
      return lines.join('\n');
    }

    lines.push(
      `${sites.length} site(s) analysed over the last 30 days, most exposed first.`,
    );
    lines.push('');
    lines.push(
      '| # | Site | Level | Risk | Incidents | Open | Late | Patrol | Peak hour |',
    );
    lines.push(
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    sites.forEach((s, idx) => {
      lines.push(
        `| ${idx + 1} | ${s.siteName} | ${s.riskLevel} | ${s.riskScore} | ` +
          `${s.incidentCount30d} | ${s.openIncidents30d} | ` +
          `${s.lateCheckInRate}% | ${s.patrolCompletionRate}% | ` +
          `${s.peakIncidentHour === null ? '—' : padHour(s.peakIncidentHour)} |`,
      );
    });
    lines.push('');

    const worst = sites[0];
    lines.push(
      `**Most exposed:** ${worst.siteName} (${worst.riskScore}/100, ${worst.riskLevel}). ` +
        `${worst.incidentCount30d} incident(s) in 30 days, ${worst.openIncidents30d} still open, ` +
        `${worst.lateCheckInRate}% late check-ins, ${worst.patrolCompletionRate}% patrol completion.`,
    );
    lines.push('');
    lines.push(`_Risk score = incidents + attendance + patrol coverage + site risk level._`);
    lines.push('');
    lines.push(this.footer(new Date().toISOString()));
    return lines.join('\n');
  }

  private renderAtRiskGuards(
    guards: Awaited<ReturnType<InsightsService['getAtRiskGuards']>>,
  ): string {
    const lines: string[] = [];
    lines.push('## Guards at risk');
    lines.push('');
    if (guards.length === 0) {
      lines.push(
        'No guards are flagged at risk. Attendance, geofence compliance and performance are all within thresholds over the last 14 days.',
      );
      lines.push('');
      lines.push(this.footer(new Date().toISOString()));
      return lines.join('\n');
    }

    lines.push(
      `${guards.length} guard(s) flagged over the last 14 days, most factors first.`,
    );
    lines.push('');
    guards.forEach((g) => {
      const emoji = SEVERITY_EMOJI[g.riskLevel] ?? '•';
      lines.push(`${emoji} **${g.fullName}** — ${g.riskLevel}`);
      lines.push(
        `${g.shift} shift · ${g.site} · performance ${g.performanceScore} · reliability ${g.reliability}%`,
      );
      if (g.riskFactors.length === 0) {
        lines.push('- No specific factor recorded');
      } else {
        for (const f of g.riskFactors) lines.push(`- ${f}`);
      }
      lines.push('');
    });
    lines.push(`_Flags are rule-based: late ≥ 3, absent ≥ 2, geofence ≥ 2, or score < 60._`);
    lines.push('');
    lines.push(this.footer(new Date().toISOString()));
    return lines.join('\n');
  }

  private footer(generatedAt: string): string {
    return `_Napoleon deterministic rules engine — generated ${generatedAt}. Not a language model; every number traces back to a stored record._`;
  }

  // ── OpenAI response envelope ─────────────────────────────────────────────

  buildCompletion(input: {
    id: string;
    created: number;
    model: string;
    intent: NapoleonIntent;
    data: unknown;
    content: string;
    promptTokens: number;
  }) {
    return {
      id: input.id,
      object: 'chat.completion' as const,
      created: input.created,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: input.content,
            // Additive, non-standard: the raw structured payload. OpenAI
            // clients ignore unknown fields, Spectra clients read them.
            napoleon: {
              intent: input.intent,
              generatedAt: new Date().toISOString(),
              analysis: input.data,
            },
          },
          finish_reason: 'stop' as const,
        },
      ],
      usage: {
        prompt_tokens: input.promptTokens,
        completion_tokens: estimateTokens(input.content),
        total_tokens: input.promptTokens + estimateTokens(input.content),
      },
      system_fingerprint: 'spectra-napoleon',
    };
  }

  /** Split rendered markdown into SSE deltas so streaming clients feel natural. */
  streamChunks(
    completion: ReturnType<OpenAiRenderer['buildCompletion']>,
    conversationId: string | null,
  ): string[] {
    const content = completion.choices[0].message.content;
    const pieces = content.match(/[\s\S]{1,120}/g) ?? [''];
    const base = {
      id: completion.id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model: completion.model,
      napoleon_conversation_id: conversationId,
    };

    const frames: string[] = [];
    const emit = (delta: Record<string, unknown>, finish: string | null) => {
      frames.push(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };

    emit({ role: 'assistant', content: '' }, null);
    for (const piece of pieces) emit({ content: piece }, null);
    emit({}, 'stop');
    frames.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [],
        usage: completion.usage,
      })}\n\n`,
    );
    frames.push('data: [DONE]\n\n');
    return frames;
  }

  newCompletionId(): string {
    return `chatcmpl-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  estimatePromptTokens(
    messages: { role: string; content: string }[],
  ): number {
    // ~4 chars/token plus 3 tokens of role/formatting overhead per message.
    return messages.reduce(
      (sum, m) => sum + estimateTokens(m.content) + 3,
      0,
    );
  }
}
