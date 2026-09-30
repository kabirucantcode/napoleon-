import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/**
 * Data ingestion.
 *
 * Napoleon does not read anyone else's database, so this is how records arrive.
 * Two properties matter more than speed here:
 *
 *  1. **Idempotence.** Every row is keyed on the caller's own `externalId`
 *     within the organization, so a client can replay a whole backfill without
 *     creating duplicates. That is what makes "just re-send it" a safe remedy.
 *  2. **Referential containment.** A reference is resolved *inside the calling
 *     organization only*. A caller cannot attach an incident to another
 *     tenant's site by guessing an external id — an unresolvable reference is a
 *     400, not a silent cross-tenant link.
 */

export interface SiteInput {
  externalId: string;
  name: string;
  riskLevel?: string;
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
  severity: string;
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

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Prisma's array form of $transaction struggles with very large arrays. */
const CHUNK_SIZE = 500;

@Injectable()
export class IngestService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Sites ───────────────────────────────────────────────────────────────

  async upsertSites(organizationId: string, sites: SiteInput[]) {
    const results = await this.prisma.$transaction(
      sites.map((site) =>
        this.prisma.site.upsert({
          where: {
            organizationId_externalId: {
              organizationId,
              externalId: site.externalId,
            },
          },
          update: {
            name: site.name,
            ...(site.riskLevel ? { riskLevel: site.riskLevel } : {}),
          },
          create: {
            organizationId,
            externalId: site.externalId,
            name: site.name,
            riskLevel: site.riskLevel ?? 'LOW',
          },
          select: { externalId: true },
        }),
      ),
    );
    return { upserted: results.length };
  }

  // ── Guards ──────────────────────────────────────────────────────────────

  async upsertGuards(organizationId: string, guards: GuardInput[]) {
    const siteIds = await this.resolveSites(
      organizationId,
      guards
        .map((g) => g.siteExternalId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );

    const results = await this.prisma.$transaction(
      guards.map((guard) => {
        const assignedSiteId =
          guard.siteExternalId && siteIds.has(guard.siteExternalId)
            ? siteIds.get(guard.siteExternalId)!
            : null;

        return this.prisma.guard.upsert({
          where: {
            organizationId_externalId: {
              organizationId,
              externalId: guard.externalId,
            },
          },
          update: {
            fullName: guard.fullName,
            ...(guard.status ? { status: guard.status } : {}),
            ...(guard.performanceScore !== undefined
              ? { performanceScore: guard.performanceScore }
              : {}),
            ...(guard.currentShift ? { currentShift: guard.currentShift } : {}),
            ...(guard.siteExternalId !== undefined ? { assignedSiteId } : {}),
          },
          create: {
            organizationId,
            externalId: guard.externalId,
            fullName: guard.fullName,
            status: guard.status ?? 'ACTIVE',
            performanceScore: guard.performanceScore ?? 100,
            currentShift: guard.currentShift ?? 'DAY',
            assignedSiteId,
          },
          select: { externalId: true },
        });
      }),
    );
    return { upserted: results.length };
  }

  // ── Incidents ───────────────────────────────────────────────────────────

  async upsertIncidents(organizationId: string, incidents: IncidentInput[]) {
    const siteIds = await this.resolveSites(
      organizationId,
      incidents.map((i) => i.siteExternalId),
    );

    const results = await this.chunked(incidents, (chunk) =>
      this.prisma.$transaction(
        chunk.map((incident) =>
          this.prisma.incident.upsert({
            where: {
              siteId_externalId: {
                siteId: siteIds.get(incident.siteExternalId)!,
                externalId: incident.externalId,
              },
            },
            update: {
              severity: incident.severity,
              reportedAt: new Date(incident.reportedAt),
              ...(incident.status ? { status: incident.status } : {}),
              ...(incident.type !== undefined ? { type: incident.type } : {}),
            },
            create: {
              siteId: siteIds.get(incident.siteExternalId)!,
              externalId: incident.externalId,
              severity: incident.severity,
              status: incident.status ?? 'OPEN',
              type: incident.type ?? null,
              reportedAt: new Date(incident.reportedAt),
            },
            select: { externalId: true },
          }),
        ),
      ),
    );
    return { upserted: results.length };
  }

  // ── Attendance ──────────────────────────────────────────────────────────

  async upsertAttendance(
    organizationId: string,
    rows: AttendanceInput[],
  ) {
    const [guardIds, siteIds] = await Promise.all([
      this.resolveGuards(
        organizationId,
        rows.map((r) => r.guardExternalId),
      ),
      this.resolveSites(
        organizationId,
        rows.map((r) => r.siteExternalId),
      ),
    ]);

    const results = await this.chunked(rows, (chunk) =>
      this.prisma.$transaction(
        chunk.map((row) =>
          this.prisma.attendance.upsert({
            where: {
              guardId_externalId: {
                guardId: guardIds.get(row.guardExternalId)!,
                externalId: row.externalId,
              },
            },
            update: {
              isLate: row.isLate ?? false,
              isAbsent: row.isAbsent ?? false,
              ...(row.status ? { status: row.status } : {}),
              ...(row.createdAt ? { createdAt: new Date(row.createdAt) } : {}),
            },
            create: {
              guardId: guardIds.get(row.guardExternalId)!,
              siteId: siteIds.get(row.siteExternalId)!,
              externalId: row.externalId,
              isLate: row.isLate ?? false,
              isAbsent: row.isAbsent ?? false,
              status: row.status ?? 'ON_TIME',
              createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
            },
            select: { externalId: true },
          }),
        ),
      ),
    );
    return { upserted: results.length };
  }

  // ── Patrols ─────────────────────────────────────────────────────────────

  async upsertPatrols(
    organizationId: string,
    routes: PatrolRouteInput[],
    records: PatrolRecordInput[],
  ) {
    const siteIds = await this.resolveSites(
      organizationId,
      routes.map((r) => r.siteExternalId),
    );

    const routeResults = await this.prisma.$transaction(
      routes.map((route) =>
        this.prisma.patrolRoute.upsert({
          where: {
            siteId_externalId: {
              siteId: siteIds.get(route.siteExternalId)!,
              externalId: route.externalId,
            },
          },
          update: { ...(route.name !== undefined ? { name: route.name } : {}) },
          create: {
            siteId: siteIds.get(route.siteExternalId)!,
            externalId: route.externalId,
            name: route.name ?? null,
          },
          select: { id: true, externalId: true },
        }),
      ),
    );

    const routeIdByExternalId = new Map(
      routeResults.map((r) => [r.externalId, r.id]),
    );

    let recordCount = 0;
    if (records.length > 0) {
      const [guardIds, resolvedRoutes] = await Promise.all([
        this.resolveGuards(
          organizationId,
          records.map((r) => r.guardExternalId),
        ),
        this.resolvePatrolRoutes(organizationId, routeIdByExternalId, records),
      ]);

      const results = await this.chunked(records, (chunk) =>
        this.prisma.$transaction(
          chunk.map((record) =>
            this.prisma.patrolRecord.upsert({
              where: {
                guardId_externalId: {
                  guardId: guardIds.get(record.guardExternalId)!,
                  externalId: record.externalId,
                },
              },
              update: {
                completionPercentage: record.completionPercentage,
                ...(record.createdAt
                  ? { createdAt: new Date(record.createdAt) }
                  : {}),
              },
              create: {
                guardId: guardIds.get(record.guardExternalId)!,
                routeId: resolvedRoutes.get(record.routeExternalId)!,
                externalId: record.externalId,
                completionPercentage: record.completionPercentage,
                createdAt: record.createdAt
                  ? new Date(record.createdAt)
                  : new Date(),
              },
              select: { externalId: true },
            }),
          ),
        ),
      );
      recordCount = results.length;
    }

    return { routesUpserted: routeResults.length, recordsUpserted: recordCount };
  }

  /**
   * Erase every operational record for the organization. Key management and the
   * organization itself survive, so the caller is not locked out by a reset.
   */
  async eraseOperationalData(organizationId: string) {
    const sites = await this.prisma.site.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const siteIds = sites.map((s) => s.id);

    const guards = await this.prisma.guard.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const guardIds = guards.map((g) => g.id);

    const deleted = await this.prisma.$transaction([
      this.prisma.patrolRecord.deleteMany({
        where: { guardId: { in: guardIds } },
      }),
      this.prisma.patrolRoute.deleteMany({ where: { siteId: { in: siteIds } } }),
      this.prisma.incident.deleteMany({ where: { siteId: { in: siteIds } } }),
      this.prisma.attendance.deleteMany({ where: { siteId: { in: siteIds } } }),
      this.prisma.guard.deleteMany({ where: { organizationId } }),
      this.prisma.site.deleteMany({ where: { organizationId } }),
    ]);

    return {
      success: true,
      deleted: {
        patrolRecords: deleted[0].count,
        patrolRoutes: deleted[1].count,
        incidents: deleted[2].count,
        attendance: deleted[3].count,
        guards: deleted[4].count,
        sites: deleted[5].count,
      },
    };
  }

  // ── Reference resolution ────────────────────────────────────────────────

  /**
   * Maps external ids to internal ids, scoped to the organization. Missing ids
   * are a hard error: silently dropping them would look like the data was
   * accepted and leave the analysis quietly wrong.
   */
  private async resolveSites(
    organizationId: string,
    externalIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(externalIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.site.findMany({
      where: { organizationId, externalId: { in: unique } },
      select: { id: true, externalId: true },
    });
    return this.assertComplete('site', unique, rows, externalIds);
  }

  private async resolveGuards(
    organizationId: string,
    externalIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(externalIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.guard.findMany({
      where: { organizationId, externalId: { in: unique } },
      select: { id: true, externalId: true },
    });
    return this.assertComplete('guard', unique, rows, externalIds);
  }

  /** Routes may be created in this same request, so consult both sources. */
  private async resolvePatrolRoutes(
    organizationId: string,
    created: Map<string, string>,
    records: PatrolRecordInput[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(records.map((r) => r.routeExternalId))];
    const missing = wanted.filter((id) => !created.has(id));

    const resolved = new Map(created);
    if (missing.length > 0) {
      const rows = await this.prisma.patrolRoute.findMany({
        where: {
          externalId: { in: missing },
          site: { organizationId },
        },
        select: { id: true, externalId: true },
      });
      for (const row of rows) resolved.set(row.externalId, row.id);
    }

    this.assertComplete(
      'patrol route',
      wanted,
      [...resolved].map(([externalId, id]) => ({ externalId, id })),
      wanted,
    );
    return resolved;
  }

  private assertComplete(
    entity: string,
    uniqueRequested: string[],
    rows: { id: string; externalId: string }[],
    _allRequested: string[],
  ): Map<string, string> {
    const map = new Map(rows.map((r) => [r.externalId, r.id]));
    const missing = uniqueRequested.filter((id) => !map.has(id));
    if (missing.length > 0) {
      const shown = missing.slice(0, 5).join(', ');
      const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
      throw new BadRequestException(
        `Unknown ${entity} externalId(s): ${shown}${more}. Ingest the referenced ${
          entity === 'patrol route' ? 'routes' : `${entity}s`
        } first — references are resolved only within your own organization.`,
      );
    }
    return map;
  }

  private async chunked<T, R>(
    items: T[],
    run: (chunk: T[]) => Promise<R[]>,
  ): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      out.push(...(await run(items.slice(i, i + CHUNK_SIZE))));
    }
    return out;
  }
}
