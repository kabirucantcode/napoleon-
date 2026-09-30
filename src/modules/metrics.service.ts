import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface IncidentMetricsQuery {
  /** Trailing window, in days. Ignored when `from` is supplied. */
  days?: number;
  /** Optional category filter. */
  type?: string;
  from?: Date;
  to?: Date;
}

export interface IncidentMetrics {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  /** Every incident ever recorded for this organization. */
  total: number;
  /** Created during the window. */
  inWindow: number;
  /** Created during the current calendar day. */
  today: number;
  /** Currently OPEN. */
  open: number;
  /** One row per day that had incidents, oldest first. */
  daily: { date: string; count: number }[];
  /** `{ "THEFT": 12, ... }`, most frequent first. */
  byType: Record<string, number>;
}

const MAX_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 30;
const UNTYPED = 'UNSPECIFIED';

/**
 * Incident aggregation.
 *
 * Counting is pushed into the database rather than fetched and tallied in
 * JavaScript: `count`, `groupBy` and a single `GROUP BY` over a date truncation
 * all run where the indexes are. The daily series is the one query Prisma's
 * fluent API cannot express, so it is raw SQL with the same tenant scope.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getIncidentMetrics(
    organizationId: string,
    query: IncidentMetricsQuery,
  ): Promise<IncidentMetrics> {
    const days = this.resolveDays(query);
    const to = query.to ?? new Date();
    const from =
      query.from ?? new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const windowWhere = {
      site: { organizationId },
      reportedAt: { gte: from, lte: to },
      ...(query.type ? { type: query.type } : {}),
    };

    const [
      total,
      inWindow,
      today,
      open,
      byTypeRows,
      daily,
    ] = await Promise.all([
      this.prisma.incident.count({ where: { site: { organizationId } } }),
      this.prisma.incident.count({ where: windowWhere }),
      this.prisma.incident.count({
        where: {
          site: { organizationId },
          reportedAt: { gte: startOfToday },
          ...(query.type ? { type: query.type } : {}),
        },
      }),
      this.prisma.incident.count({
        where: {
          site: { organizationId },
          status: 'OPEN',
          ...(query.type ? { type: query.type } : {}),
        },
      }),
      this.prisma.incident.groupBy({
        by: ['type'],
        where: windowWhere,
        _count: { _all: true },
      }),
      this.dailySeries(organizationId, from, to, query.type ?? null),
    ]);

    // Most frequent first, so a UI can render the map in a useful order.
    const byType: Record<string, number> = {};
    byTypeRows
      .map((row) => ({
        type: row.type ?? UNTYPED,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .forEach((row) => {
        byType[row.type] = row.count;
      });

    return {
      generatedAt: new Date().toISOString(),
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        days,
      },
      total,
      inWindow,
      today,
      open,
      daily,
      byType,
    };
  }

  private resolveDays(query: IncidentMetricsQuery): number {
    if (query.from) {
      const to = query.to ?? new Date();
      const span = Math.ceil(
        (to.getTime() - query.from.getTime()) / (24 * 60 * 60 * 1000),
      );
      return Math.max(1, Math.min(span, MAX_WINDOW_DAYS));
    }
    const days = query.days ?? DEFAULT_WINDOW_DAYS;
    if (!Number.isFinite(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      throw new BadRequestException(
        `\`days\` must be between 1 and ${MAX_WINDOW_DAYS}.`,
      );
    }
    return Math.floor(days);
  }

  /**
   * Incidents per calendar day. `DATE_TRUNC` groups in the database; the JOIN
   * carries the tenant scope, because Incident itself has no organization
   * column to filter on.
   */
  private async dailySeries(
    organizationId: string,
    from: Date,
    to: Date,
    type: string | null,
  ): Promise<{ date: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<
      { day: Date; count: number }[]
    >`
      SELECT DATE_TRUNC('day', i."reportedAt") AS day,
             COUNT(*)::int AS count
      FROM "Incident" i
      JOIN "Site" s ON s."id" = i."siteId"
      WHERE s."organizationId" = ${organizationId}
        AND i."reportedAt" >= ${from}
        AND i."reportedAt" <= ${to}
        AND (${type}::text IS NULL OR i."type" = ${type})
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return rows.map((row) => ({
      date: row.day.toISOString().slice(0, 10),
      count: Number(row.count),
    }));
  }
}
