'use strict';

/**
 * Engine smoke test.
 *
 * Runs the real InsightsService against a stubbed Prisma, so the arithmetic that
 * operators act on is verified without needing a database. The stub applies the
 * window and status filters the engine relies on, so windowing is exercised
 * rather than assumed.
 *
 *   node scripts/smoke-engine.js
 */

const { boot, check, summary, requireDist } = require('./_harness');

const { InsightsService } = requireDist('engine/insights.service');

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days, hour = 10) => {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
};

// ── Fixture ─────────────────────────────────────────────────────────────────
// Expected overview, derived by hand from the rows below:
//   avgPerformance  (100+80+50+90+20)/5 = 68   (the SUSPENDED guard is excluded)
//   openIncidents   4
//   lateRate        5/10 = 50%
//   patrol          (100+60)/2 = 80
//   healthScore     68*0.40 + (100-12)*0.25 + (100-50)*0.20 + 80*0.15
//                 = 27.2 + 22 + 10 + 12 = 71.2 -> 71
const sites = [
  { id: 'site-a', organizationId: ORG, name: 'Riverside', riskLevel: 'CRITICAL' },
  { id: 'site-b', organizationId: ORG, name: 'Okonkwo Plaza', riskLevel: 'LOW' },
  { id: 'site-x', organizationId: OTHER_ORG, name: 'Not Mine', riskLevel: 'HIGH' },
];

const guards = [
  { id: 'g1', organizationId: ORG, fullName: 'Ada', status: 'ACTIVE', performanceScore: 100, currentShift: 'DAY', assignedSite: { name: 'Riverside' } },
  { id: 'g2', organizationId: ORG, fullName: 'Bola', status: 'ACTIVE', performanceScore: 80, currentShift: 'NIGHT', assignedSite: { name: 'Riverside' } },
  { id: 'g3', organizationId: ORG, fullName: 'Chidi', status: 'ACTIVE', performanceScore: 50, currentShift: 'DAY', assignedSite: { name: 'Okonkwo Plaza' } },
  { id: 'g4', organizationId: ORG, fullName: 'Dara', status: 'ACTIVE', performanceScore: 90, currentShift: 'DAY', assignedSite: null },
  { id: 'g5', organizationId: ORG, fullName: 'Eze', status: 'ACTIVE', performanceScore: 20, currentShift: 'NIGHT', assignedSite: null },
  // Suspended guards must not enter the average.
  { id: 'g6', organizationId: ORG, fullName: 'Idle', status: 'SUSPENDED', performanceScore: 0, currentShift: 'OFF', assignedSite: null },
];

const incidents = [
  { id: 'i1', siteId: 'site-a', severity: 'CRITICAL', status: 'OPEN', reportedAt: ago(1, 10) },
  { id: 'i2', siteId: 'site-a', severity: 'HIGH', status: 'OPEN', reportedAt: ago(2, 22) },
  { id: 'i3', siteId: 'site-b', severity: 'LOW', status: 'OPEN', reportedAt: ago(3, 10) },
  { id: 'i4', siteId: 'site-b', severity: 'MEDIUM', status: 'OPEN', reportedAt: ago(4, 11) },
  // Outside the 30-day window — must not be counted.
  { id: 'old', siteId: 'site-a', severity: 'CRITICAL', status: 'OPEN', reportedAt: ago(120, 10) },
];

const attendance = [
  { id: 'a1', guardId: 'g1', siteId: 'site-a', isLate: false, isAbsent: false, status: 'ON_TIME', createdAt: ago(1) },
  { id: 'a2', guardId: 'g2', siteId: 'site-a', isLate: true, isAbsent: false, status: 'LATE', createdAt: ago(1) },
  { id: 'a3', guardId: 'g2', siteId: 'site-a', isLate: true, isAbsent: false, status: 'LATE', createdAt: ago(2) },
  { id: 'a4', guardId: 'g2', siteId: 'site-a', isLate: true, isAbsent: false, status: 'LATE', createdAt: ago(3) },
  { id: 'a5', guardId: 'g1', siteId: 'site-a', isLate: false, isAbsent: false, status: 'FLAGGED', createdAt: ago(2) },
  { id: 'a6', guardId: 'g4', siteId: 'site-b', isLate: false, isAbsent: false, status: 'ON_TIME', createdAt: ago(3) },
  { id: 'a7', guardId: 'g5', siteId: 'site-b', isLate: true, isAbsent: false, status: 'LATE', createdAt: ago(4) },
  { id: 'a8', guardId: 'g3', siteId: 'site-b', isLate: false, isAbsent: false, status: 'ON_TIME', createdAt: ago(4) },
  { id: 'a9', guardId: 'g3', siteId: 'site-b', isLate: false, isAbsent: false, status: 'ON_TIME', createdAt: ago(5) },
  { id: 'a10', guardId: 'g1', siteId: 'site-a', isLate: false, isAbsent: false, status: 'ON_TIME', createdAt: ago(6) },
];

const patrolRoutes = [{ id: 'r1', siteId: 'site-a' }];
const patrolRecords = [
  { id: 'p1', routeId: 'r1', guardId: 'g1', completionPercentage: 100, createdAt: ago(1) },
  { id: 'p2', routeId: 'r1', guardId: 'g1', completionPercentage: 60, createdAt: ago(2) },
];

// ── Stub Prisma ─────────────────────────────────────────────────────────────
// Applies only the filters the engine depends on: org, status and gte windows.
// Everything else is returned as-is, which keeps the fixture honest — if the
// engine silently relied on a filter this does not apply, the assertions fail.

function applies(row, where = {}, orgKey = 'organizationId') {
  if (where[orgKey] !== undefined && row[orgKey] !== where[orgKey]) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  for (const field of ['reportedAt', 'createdAt']) {
    const clause = where[field];
    if (clause && clause.gte && new Date(row[field]) < clause.gte) return false;
  }
  return true;
}

/** Rows whose parent relation matches an organization filter (site/guard scoped). */
function byRelation(rows, parentTable, where, keyOf) {
  const parentOrg = where?.site?.organizationId ?? where?.guard?.organizationId;
  if (parentOrg === undefined) return rows;
  const parentIds = new Set(
    parentTable.filter((p) => p.organizationId === parentOrg).map((p) => p.id),
  );
  return rows.filter((row) => parentIds.has(keyOf(row)));
}

const prisma = {
  site: {
    findMany: async ({ where }) => sites.filter((s) => applies(s, where)),
  },
  guard: {
    findMany: async ({ where }) => guards.filter((g) => applies(g, where)),
  },
  incident: {
    findMany: async ({ where }) => {
      const scoped = byRelation(incidents, sites, where, (i) => i.siteId);
      return scoped.filter((i) => applies(i, where));
    },
  },
  attendance: {
    findMany: async ({ where }) => {
      const scoped = byRelation(attendance, guards, where, (a) => a.guardId);
      return scoped.filter((a) => applies(a, where));
    },
  },
  patrolRoute: {
    findMany: async ({ where }) => {
      const scoped = byRelation(patrolRoutes, sites, where, (r) => r.siteId);
      return scoped.map((r) => ({ id: r.id, siteId: r.siteId }));
    },
  },
  patrolRecord: {
    findMany: async ({ where }) => {
      const scoped = byRelation(patrolRecords, guards, where, (p) => p.guardId);
      return scoped.filter((p) => applies(p, where));
    },
  },
};

const engine = new InsightsService(prisma);

async function main() {
  // ── Overview ──────────────────────────────────────────────────────────────
  boot('getOverview');
  const overview = await engine.getOverview(ORG);

  check('health score matches the weighted formula', overview.healthScore === 71, overview.healthScore);
  check('suspended guards are excluded from the average', overview.avgGuardPerformance === 68, overview.avgGuardPerformance);
  check('only OPEN incidents count as open', overview.openIncidents === 4, overview.openIncidents);
  check('incidents outside the 30-day window are ignored', overview.openIncidents === 4);
  check('late/flagged rate is a percentage', overview.lateCheckInRate === 50, overview.lateCheckInRate);
  check('patrol completion is the mean of the window', overview.patrolCompletionRate === 80, overview.patrolCompletionRate);
  check('at-risk guard count is performance < 60', overview.atRiskGuardCount === 2, overview.atRiskGuardCount);
  check('other organizations are excluded', overview.siteCount === 2, overview.siteCount);
  check('a generatedAt timestamp is present', typeof overview.generatedAt === 'string');

  const categories = overview.insights.map((i) => i.category);
  check('open-incident surge raises an INCIDENTS insight', categories.includes('INCIDENTS'));
  check('late check-ins raise an ATTENDANCE insight', categories.includes('ATTENDANCE'));
  check('low performers raise a PERSONNEL insight', categories.includes('PERSONNEL'));
  check('patrol completion exactly at 80 does not raise PATROLS', !categories.includes('PATROLS'));
  const incidentsInsight = overview.insights.find((i) => i.category === 'INCIDENTS');
  check('the most severe insight is HIGH', incidentsInsight.severity === 'HIGH');

  // Boundary: dropping patrol completion below target must flip the insight on.
  patrolRecords[1].completionPercentage = 40;
  const belowTarget = await engine.getOverview(ORG);
  check(
    'patrol completion below 80 raises PATROLS',
    belowTarget.insights.some((i) => i.category === 'PATROLS'),
  );
  patrolRecords[1].completionPercentage = 60;

  // ── Risk by site ──────────────────────────────────────────────────────────
  boot('getRiskBySite');
  const risk = await engine.getRiskBySite(ORG);
  check('one row per site in the organization', risk.length === 2, risk.length);
  check('sorted most exposed first', risk[0].riskScore >= risk[1].riskScore);

  const riverside = risk.find((s) => s.siteName === 'Riverside');
  // Incidents: CRITICAL 40 + HIGH 25 = 65, capped at 60.
  // Attendance for this site: 6 rows, 4 late/flagged = 66.7% -> *0.25 = 16.67
  // Patrols: (100+60)/2 = 80 -> (100-80)*0.35 = 7
  // CRITICAL site bonus: 10
  // 60 + 16.67 + 7 + 10 = 93.67 -> 94
  check('severe incidents are capped at 60 before weighting', riverside.riskScore === 94, riverside.riskScore);
  check('incident count is windowed', riverside.incidentCount30d === 2, riverside.incidentCount30d);
  check('open incident count is reported', riverside.openIncidents30d === 2);
  check('peak incident hour is derived', typeof riverside.peakIncidentHour === 'number' || riverside.peakIncidentHour === null);

  const plaza = risk.find((s) => s.siteName === 'Okonkwo Plaza');
  check('a site with no patrols scores 100% completion', plaza.patrolCompletionRate === 100, plaza.patrolCompletionRate);
  check('peak hour is the busiest hour of the day', plaza.peakIncidentHour === 10, plaza.peakIncidentHour);

  const barren = sites.find((s) => s.id === 'site-x');
  check('sites from another organization are not ranked', barren !== undefined && !risk.some((s) => s.siteId === 'site-x'));

  // ── At-risk guards ────────────────────────────────────────────────────────
  boot('getAtRiskGuards');
  const atRisk = await engine.getAtRiskGuards(ORG);
  const names = atRisk.map((g) => g.fullName);
  check('only non-LOW guards are returned', names.length === 3, JSON.stringify(names));
  check('a sub-60 performer is flagged HIGH', atRisk.find((g) => g.fullName === 'Chidi')?.riskLevel === 'HIGH');
  check('three late check-ins reach MEDIUM', atRisk.find((g) => g.fullName === 'Bola')?.riskLevel === 'MEDIUM');
  check('a clean guard is omitted', !names.includes('Ada'));
  check('a very low score is flagged HIGH', atRisk.find((g) => g.fullName === 'Eze')?.riskLevel === 'HIGH');
  check('a suspended guard is never flagged', !names.includes('Idle'), JSON.stringify(names));

  const chidi = atRisk.find((g) => g.fullName === 'Chidi');
  check('the reason is human readable', chidi.riskFactors.some((f) => f.includes('performance score')));
  const bola = atRisk.find((g) => g.fullName === 'Bola');
  check('reliability accounts for late days', bola.reliability === 0, bola.reliability);
  check('a no-history guard is treated as fully reliable', chidi.reliability === 100, chidi.reliability);

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
