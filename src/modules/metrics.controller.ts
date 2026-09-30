import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { MetricsService } from './metrics.service';
import type { Principal } from '../auth/principal';

@Controller('metrics')
@UseGuards(ApiKeyGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * `GET /metrics/incidents`
   *
   * `total`      every incident on record
   * `inWindow`   created inside the window (default 30 days)
   * `today`      created during the current calendar day
   * `open`       currently unresolved
   * `daily[]`    one row per day that had incidents
   * `byType`     { "THEFT": 12, ... }, most frequent first
   *
   * Filters: `?days=30`, `?type=THEFT`, or an explicit `?from=&to=` ISO range.
   */
  @Get('incidents')
  incidents(
    @CurrentPrincipal() principal: Principal,
    @Query('days') days?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.metrics.getIncidentMetrics(principal.organizationId, {
      days: days === undefined ? undefined : Number(days),
      type: type?.trim() || undefined,
      from: this.parseDate(from, 'from'),
      to: this.parseDate(to, 'to'),
    });
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `\`${field}\` must be an ISO 8601 date, e.g. 2026-09-01.`,
      );
    }
    return parsed;
  }
}
