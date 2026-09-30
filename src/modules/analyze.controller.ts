import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { computeStats } from '../engine/stats';
import type { MetricStats, Prior } from '../engine/baseline-store';
import { resolveSeverity, scoreAgainst } from '../engine/surprise';
import type { SurpriseResult } from '../engine/surprise';
import type { Principal } from '../auth/principal';

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

interface Analyzed extends SurpriseResult {
  entityId?: string;
  severity: Severity;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function readHistory(raw: unknown, field: string): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestException(`\`${field}\` must be an array of numbers.`);
  }
  return raw.map((v, i) => {
    if (!isFiniteNumber(v)) {
      throw new BadRequestException(
        `\`${field}[${i}]\` must be a finite number.`,
      );
    }
    return v;
  });
}

function readPrior(raw: unknown): Prior | undefined {
  if (raw === undefined || raw === null) return undefined;
  const prior = raw as { mean?: unknown; stdDev?: unknown };
  if (!isFiniteNumber(prior.mean) || !isFiniteNumber(prior.stdDev)) {
    throw new BadRequestException(
      '`prior` must be `{ mean: number, stdDev: number }`.',
    );
  }
  return { mean: prior.mean, stdDev: prior.stdDev };
}

function readDate(raw: unknown, field: string): Date | undefined {
  if (raw === undefined || raw === null) return undefined;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(
      `\`${field}\` must be an ISO 8601 date. It only affects the day-of-week baseline.`,
    );
  }
  return date;
}

/**
 * "Is this value unusual?" — the stateless half of Napoleon.
 *
 * The caller supplies the history, so this endpoint reads and writes nothing.
 * That is what makes the engine reusable by a system that already stores its own
 * time series and does not want its data copied somewhere else: it needs no
 * ingest, no sites, no guards, just numbers.
 */
@Controller('analyze')
@UseGuards(ApiKeyGuard)
export class AnalyzeController {
  @Post()
  analyze(
    @CurrentPrincipal() _principal: Principal,
    @Body() body: Record<string, unknown>,
  ): Analyzed {
    const item = this.readItem(body);
    return this.scoreOne(item);
  }

  /**
   * Score many values in one round trip. Each item is scored independently
   * against its own history, so a batch is a convenience, not a shared context.
   */
  @Post('batch')
  batch(@Body() body: Record<string, unknown>) {
    if (!Array.isArray(body?.items)) {
      throw new BadRequestException('`items` must be an array.');
    }
    if (body.items.length > 1000) {
      throw new BadRequestException(
        'A batch is limited to 1000 items. Split larger runs.',
      );
    }
    return {
      results: (body.items as Record<string, unknown>[]).map((raw, i) => {
        try {
          return this.scoreOne(this.readItem(raw));
        } catch (err) {
          // One malformed item must not discard the rest of the batch.
          return {
            index: i,
            error: err instanceof Error ? err.message : 'Invalid item',
          };
        }
      }),
    };
  }

  private readItem(body: Record<string, unknown>) {
    const metric = typeof body?.metric === 'string' ? body.metric.trim() : '';
    if (!metric) {
      throw new BadRequestException(
        '`metric` is required — it labels the result and nothing more.',
      );
    }
    if (!isFiniteNumber(body?.value)) {
      throw new BadRequestException('`value` must be a finite number.');
    }
    return {
      metric,
      value: body.value,
      history: readHistory(body?.history, 'history'),
      date: readDate(body?.date, 'date'),
      prior: readPrior(body?.prior),
      priorStrength: isFiniteNumber(body?.priorStrength)
        ? body.priorStrength
        : undefined,
      entityId:
        typeof body?.entityId === 'string' ? body.entityId : undefined,
    };
  }

  private scoreOne(input: {
    metric: string;
    value: number;
    history: number[];
    date?: Date;
    prior?: Prior;
    priorStrength?: number;
    entityId?: string;
  }): Analyzed {
    const stats: MetricStats = computeStats(input.history);
    const result = scoreAgainst({
      metric: input.metric,
      value: input.value,
      stats,
      series: input.history,
      date: input.date,
      prior: input.prior,
      priorStrength: input.priorStrength,
    });

    return {
      ...result,
      entityId: input.entityId,
      severity: resolveSeverity(result.surprise),
    };
  }
}
