import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

const SEVERITY_WEIGHT: Record<string, number> = {
  CRITICAL: 40,
  HIGH: 25,
  MEDIUM: 12,
  LOW: 5,
};

const clamp = (n: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Math.round(n)));

/**
 * The Napoleon engine: deterministic, explainable signals computed from the
 * ingested operational records (incidents, attendance, patrols, personnel
 * performance). Each insight is rule-based so an operator can trust and audit
 * it; the surface is designed so a learned model can slot in behind the same
 * methods later.
 *
 * Ported unchanged from Spectra. Every query reads only the field names the
 * standalone schema reproduces, so this file contains no product-specific
 * knowledge and no HTTP awareness.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(private prisma: PrismaService) {}

  private startOfWindow(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * How much of the picture we actually have.
   *
   * `EMPTY` means nothing has been ingested, so no metric should be reported at
   * all — a health score of 0 there would read as a catastrophe rather than an
   * absence of data. `PARTIAL` means some inputs are present but not all, so
   * the score is computed over what exists and the caller should not compare it
   * to a fully-instrumented organization.
   */
  private dataStatus(input: {
    sites: unknown[];
    guards: unknown[];
    incidents: unknown[];
    attendance: unknown[];
    patrols: unknown[];
  }): 'EMPTY' | 'PARTIAL' | 'OK' {
    const any =
      input.sites.length > 0 ||
      input.guards.length > 0 ||
      input.incidents.length > 0 ||
      input.attendance.length > 0 ||
      input.patrols.length > 0;
    if (!any) return 'EMPTY';

    const all =
      input.sites.length > 0 &&
      input.guards.length > 0 &&
      input.attendance.length > 0 &&
      input.patrols.length > 0;
    return all ? 'OK' : 'PARTIAL';
  }

  // ── Public surface ────────────────────────────────────────────────────────

  async getOverview(organizationId: string) {
    const since30 = this.startOfWindow(30);
    const since14 = this.startOfWindow(14);

    const [sites, guards, incidents, attendance, patrols] = await Promise.all([
      this.prisma.site.findMany({
        where: { organizationId },
        select: { id: true, name: true, riskLevel: true },
      }),
      this.prisma.guard.findMany({
        where: { organizationId, status: 'ACTIVE' },
        select: { id: true, performanceScore: true },
      }),
      this.prisma.incident.findMany({
        where: { site: { organizationId }, reportedAt: { gte: since30 } },
        select: {
          severity: true,
          status: true,
          siteId: true,
          reportedAt: true,
        },
      }),
      this.prisma.attendance.findMany({
        where: { guard: { organizationId }, createdAt: { gte: since14 } },
        select: { isLate: true, isAbsent: true, status: true },
      }),
      this.prisma.patrolRecord.findMany({
        where: { guard: { organizationId }, createdAt: { gte: since14 } },
        select: { completionPercentage: true },
      }),
    ]);

    const openIncidents = incidents.filter((i) => i.status === 'OPEN').length;
    const avgPerformance =
      guards.length === 0
        ? 0
        : guards.reduce((s, g) => s + (g.performanceScore ?? 0), 0) /
          guards.length;
    const lateRate =
      attendance.length === 0
        ? 0
        : (attendance.filter((a) => a.isLate || a.status === 'FLAGGED').length /
            attendance.length) *
          100;
    const patrolCompletion =
      patrols.length === 0
        ? 0
        : patrols.reduce((s, p) => s + p.completionPercentage, 0) /
          patrols.length;

    const dataStatus = this.dataStatus({
      sites,
      guards,
      incidents,
      attendance,
      patrols,
    });

    // Score only the components that actually have data behind them, then
    // renormalise. Averaging a missing metric in as zero would report a patrol
    // failure for an organization that has never run a patrol, and would drag
    // the health score down for data that simply has not arrived yet.
    const components: { value: number; weight: number }[] = [];
    if (guards.length > 0) {
      components.push({ value: avgPerformance, weight: 0.4 });
    }
    // Incident count is always meaningful: zero open incidents is a real result.
    components.push({ value: 100 - openIncidents * 3, weight: 0.25 });
    if (attendance.length > 0) {
      components.push({ value: 100 - lateRate, weight: 0.2 });
    }
    if (patrols.length > 0) {
      components.push({ value: patrolCompletion, weight: 0.15 });
    }

    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const healthScore =
      dataStatus === 'EMPTY' || totalWeight === 0
        ? 0
        : clamp(
            components.reduce((sum, c) => sum + c.value * c.weight, 0) /
              totalWeight,
          );

    const insights = await this.buildInsights(organizationId, {
      sites,
      guards,
      incidents,
      attendance,
      patrols,
      lateRate,
      patrolCompletion,
      avgPerformance,
    });

    return {
      generatedAt: new Date().toISOString(),
      dataStatus,
      healthScore,
      openIncidents,
      avgGuardPerformance: Math.round(avgPerformance),
      lateCheckInRate: Math.round(lateRate * 10) / 10,
      patrolCompletionRate: Math.round(patrolCompletion * 10) / 10,
      atRiskGuardCount: guards.filter((g) => (g.performanceScore ?? 0) < 60)
        .length,
      siteCount: sites.length,
      insights,
    };
  }

  async getRiskBySite(organizationId: string) {
    const sites = await this.prisma.site.findMany({
      where: { organizationId },
      select: { id: true, name: true, riskLevel: true },
    });

    const since = this.startOfWindow(30);
    const [incidents, attendance] = await Promise.all([
      this.prisma.incident.findMany({
        where: { site: { organizationId }, reportedAt: { gte: since } },
        select: {
          severity: true,
          siteId: true,
          reportedAt: true,
          status: true,
        },
      }),
      this.prisma.attendance.findMany({
        where: { guard: { organizationId }, createdAt: { gte: since } },
        select: { siteId: true, isLate: true, isAbsent: true, status: true },
      }),
    ]);

    // Patrol completion by site (via route → site)
    const patrolRoutes = await this.prisma.patrolRoute.findMany({
      where: { site: { organizationId } },
      select: { id: true, siteId: true },
    });
    const routeToSite = new Map(patrolRoutes.map((r) => [r.id, r.siteId]));
    const patrolRecords = await this.prisma.patrolRecord.findMany({
      where: { guard: { organizationId }, createdAt: { gte: since } },
      select: { routeId: true, completionPercentage: true },
    });
    const patrolBySite = new Map<string, number[]>();
    for (const p of patrolRecords) {
      const siteId = routeToSite.get(p.routeId);
      if (!siteId) continue;
      if (!patrolBySite.has(siteId)) patrolBySite.set(siteId, []);
      patrolBySite.get(siteId)!.push(p.completionPercentage);
    }

    const bySite = new Map<
      string,
      {
        incidents: { severity: string; status: string; reportedAt: Date }[];
        attendance: { isLate: boolean; isAbsent: boolean; status: string }[];
      }
    >();
    for (const s of sites) bySite.set(s.id, { incidents: [], attendance: [] });
    for (const i of incidents) bySite.get(i.siteId)?.incidents.push(i);
    for (const a of attendance) bySite.get(a.siteId)?.attendance.push(a);

    const result = sites.map((site) => {
      const { incidents: siteInc, attendance: siteAtt } = bySite.get(
        site.id,
      ) ?? {
        incidents: [],
        attendance: [],
      };
      const sitePatrols = patrolBySite.get(site.id) ?? [];
      const incidentScore = siteInc.reduce(
        (s, i) => s + (SEVERITY_WEIGHT[i.severity] ?? 5),
        0,
      );
      const lateRate =
        siteAtt.length === 0
          ? 0
          : (siteAtt.filter((a) => a.isLate || a.status === 'FLAGGED').length /
              siteAtt.length) *
            100;
      const patrolCompletion =
        sitePatrols.length === 0
          ? 100
          : sitePatrols.reduce((s, p) => s + p, 0) / sitePatrols.length;

      const riskScore = clamp(
        Math.min(incidentScore, 60) +
          lateRate * 0.25 +
          (100 - patrolCompletion) * 0.35 +
          (site.riskLevel === 'CRITICAL'
            ? 10
            : site.riskLevel === 'HIGH'
              ? 6
              : site.riskLevel === 'MEDIUM'
                ? 3
                : 0),
      );

      const hourBuckets = new Array(24).fill(0) as number[];
      for (const i of siteInc)
        hourBuckets[new Date(i.reportedAt).getHours()]++;
      const peakHour = hourBuckets.reduce(
        (best, c, h) => (c > hourBuckets[best] ? h : best),
        0,
      );

      return {
        siteId: site.id,
        siteName: site.name,
        riskLevel: site.riskLevel,
        riskScore,
        incidentCount30d: siteInc.length,
        openIncidents30d: siteInc.filter((i) => i.status === 'OPEN').length,
        lateCheckInRate: Math.round(lateRate * 10) / 10,
        patrolCompletionRate: Math.round(patrolCompletion * 10) / 10,
        peakIncidentHour: hourBuckets[peakHour] > 0 ? peakHour : null,
      };
    });

    result.sort((a, b) => b.riskScore - a.riskScore);
    return result;
  }

  async getAtRiskGuards(organizationId: string) {
    const since = this.startOfWindow(14);
    const [guards, attendance] = await Promise.all([
      this.prisma.guard.findMany({
        where: { organizationId, status: 'ACTIVE' },
        select: {
          id: true,
          fullName: true,
          performanceScore: true,
          currentShift: true,
          assignedSite: { select: { name: true } },
        },
      }),
      this.prisma.attendance.findMany({
        where: { guard: { organizationId }, createdAt: { gte: since } },
        select: {
          guardId: true,
          isLate: true,
          isAbsent: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    const byGuard = new Map<
      string,
      { late: number; flagged: number; absent: number; days: Set<string> }
    >();
    for (const g of guards)
      byGuard.set(g.id, { late: 0, flagged: 0, absent: 0, days: new Set() });
    for (const a of attendance) {
      const row = byGuard.get(a.guardId);
      if (!row) continue;
      row.days.add(a.createdAt.toISOString().slice(0, 10));
      if (a.isAbsent || a.status === 'ABSENT') row.absent++;
      else if (a.isLate) row.late++;
      if (a.status === 'FLAGGED') row.flagged++;
    }

    return guards
      .map((g) => {
        const stats = byGuard.get(g.id) ?? {
          late: 0,
          flagged: 0,
          absent: 0,
          days: new Set<string>(),
        };
        const workedDays = stats.days.size;
        const reliability =
          workedDays === 0
            ? 100
            : Math.max(
                0,
                Math.round(
                  ((workedDays - stats.late - stats.absent) /
                    Math.max(workedDays, 1)) *
                    100,
                ),
              );

        let riskLevel = 'LOW';
        const riskFactors: string[] = [];
        if (stats.late >= 3) {
          riskLevel = 'MEDIUM';
          riskFactors.push(`${stats.late} late check-ins in 14 days`);
        }
        if (stats.absent >= 2) {
          riskLevel = riskLevel === 'MEDIUM' ? 'HIGH' : 'MEDIUM';
          riskFactors.push(`${stats.absent} absent days in 14 days`);
        }
        if (stats.flagged >= 2) {
          riskLevel = riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
          riskFactors.push(`${stats.flagged} geofence violations`);
        }
        if ((g.performanceScore ?? 100) < 60) {
          riskLevel = 'HIGH';
          riskFactors.push(`performance score ${g.performanceScore}`);
        }

        return {
          guardId: g.id,
          fullName: g.fullName,
          shift: g.currentShift,
          site: g.assignedSite?.name ?? 'Unassigned',
          performanceScore: g.performanceScore ?? 100,
          reliability,
          lateCount: stats.late,
          absentCount: stats.absent,
          flaggedCount: stats.flagged,
          riskLevel,
          riskFactors,
        };
      })
      .filter((g) => g.riskLevel !== 'LOW')
      .sort((a, b) => b.riskFactors.length - a.riskFactors.length);
  }

  // ── Insight rules ─────────────────────────────────────────────────────────

  private async buildInsights(
    _organizationId: string,
    ctx: {
      sites: { id: string; name: string; riskLevel: string }[];
      guards: { id: string; performanceScore: number | null }[];
      incidents: {
        severity: string;
        status: string;
        siteId: string;
        reportedAt: Date;
      }[];
      attendance: { isLate: boolean; isAbsent: boolean; status: string }[];
      patrols: { completionPercentage: number }[];
      lateRate: number;
      patrolCompletion: number;
      avgPerformance: number;
    },
  ): Promise<
    {
      severity: string;
      category: string;
      title: string;
      detail: string;
      recommendation: string;
      metric: string;
    }[]
  > {
    const insights: {
      severity: string;
      category: string;
      title: string;
      detail: string;
      recommendation: string;
      metric: string;
    }[] = [];

    // A metric with no rows behind it has no completion rate, no lateness rate
    // and no performance problem. Firing on the default of zero would report a
    // failure for work that has not happened rather than work that went badly.
    const hasAnyData =
      ctx.sites.length > 0 ||
      ctx.guards.length > 0 ||
      ctx.incidents.length > 0 ||
      ctx.attendance.length > 0 ||
      ctx.patrols.length > 0;

    const open = ctx.incidents.filter((i) => i.status === 'OPEN').length;
    if (open >= 3) {
      insights.push({
        severity: 'HIGH',
        category: 'INCIDENTS',
        title: `${open} open incidents need attention`,
        detail: `Response has not closed ${open} incident(s) in the last 30 days. Unresolved incidents compound liability and client risk.`,
        recommendation:
          'Assign owners to open incidents and escalate anything over 48 hours old.',
        metric: `${open} open`,
      });
    }

    if (ctx.attendance.length > 0 && ctx.lateRate > 20) {
      insights.push({
        severity: 'MEDIUM',
        category: 'ATTENDANCE',
        title: `Late check-ins running at ${Math.round(ctx.lateRate)}%`,
        detail:
          'More than 1 in 5 check-ins over the last 14 days was late or flagged outside the geofence.',
        recommendation:
          'Review shift start times and consider SMS reminders 30 minutes before shift.',
        metric: `${Math.round(ctx.lateRate)}%`,
      });
    }

    if (ctx.patrols.length > 0 && ctx.patrolCompletion < 80) {
      insights.push({
        severity: 'MEDIUM',
        category: 'PATROLS',
        title: `Patrol completion at ${Math.round(ctx.patrolCompletion)}%`,
        detail:
          'Patrol routes are being completed below the 80% target, leaving coverage gaps.',
        recommendation:
          'Reassign under-completed routes to guards on overlapping shifts.',
        metric: `${Math.round(ctx.patrolCompletion)}%`,
      });
    }

    const nightIncidents = ctx.incidents.filter((i) => {
      const h = new Date(i.reportedAt).getHours();
      return h >= 18 || h < 6;
    }).length;
    if (
      nightIncidents > 0 &&
      nightIncidents / Math.max(ctx.incidents.length, 1) > 0.5
    ) {
      insights.push({
        severity: 'MEDIUM',
        category: 'PATTERNS',
        title: `Most incidents occur at night (${Math.round((nightIncidents / ctx.incidents.length) * 100)}%)`,
        detail:
          'Night hours carry the majority of incident load — a sign coverage thins when visibility drops.',
        recommendation:
          'Add a dedicated night supervisor and increase patrol frequency after 20:00.',
        metric: `${nightIncidents}/${ctx.incidents.length}`,
      });
    }

    const lowPerformers = ctx.guards.filter(
      (g) => (g.performanceScore ?? 0) < 60,
    ).length;
    if (lowPerformers > 0) {
      insights.push({
        severity: lowPerformers > 3 ? 'HIGH' : 'MEDIUM',
        category: 'PERSONNEL',
        title: `${lowPerformers} guard(s) scoring below 60`,
        detail:
          'Performance scores indicate attendance and reliability problems that can become attrition risk.',
        recommendation:
          'Schedule check-ins with the at-risk guards and review their site assignments.',
        metric: `${lowPerformers} guards`,
      });
    }

    if (insights.length === 0) {
      if (!hasAnyData) {
        insights.push({
          severity: 'INFO',
          category: 'HEALTH',
          title: 'Nothing has been ingested yet',
          detail:
            'Napoleon holds no sites, personnel, incidents, attendance or patrols for this organization, so there is no behaviour to analyse and no score to report.',
          recommendation:
            'Send records to POST /api/v1/ingest/sites, then /guards, /incidents, /attendance and /patrols. The overview becomes meaningful as soon as the first data lands.',
          metric: '0 records',
        });
        return insights;
      }
      insights.push({
        severity: 'INFO',
        category: 'HEALTH',
        title: 'Operations are stable',
        detail:
          'No anomalies detected across attendance, incidents, or patrols in the review window.',
        recommendation:
          'Continue monitoring — Napoleon will alert you the moment a pattern shifts.',
        metric: 'All clear',
      });
    }

    return insights;
  }
}
