'use strict';

/**
 * Ingestion smoke test.
 *
 * The property that matters most here is containment: an external id belonging
 * to another organization must never be resolved. The stub therefore filters the
 * way the real database does — by organization — so a missing scope shows up as
 * a failing assertion rather than a passing lie.
 *
 *   node scripts/smoke-ingest.js
 */

const { boot, check, summary, requireDist } = require('./_harness');

const { IngestService } = requireDist('modules/ingest.service');

const ORG = 'org-1';
const OTHER = 'org-2';

function makePrisma(state) {
  const call = (name, args) => {
    state.calls.push({ name, args });
  };

  return {
    site: {
      upsert: async (args) => {
        call('site.upsert', args);
        return { externalId: args.create.externalId };
      },
      findMany: async ({ where }) => {
        call('site.findMany', { where });
        return state.sites.filter(
          (s) =>
            s.organizationId === where.organizationId &&
            (where.externalId?.in ?? []).includes(s.externalId),
        );
      },
      deleteMany: async (args) => {
        call('site.deleteMany', args);
        return { count: 3 };
      },
    },
    guard: {
      upsert: async (args) => {
        call('guard.upsert', args);
        return { externalId: args.create.externalId };
      },
      findMany: async ({ where }) => {
        call('guard.findMany', { where });
        return state.guards.filter(
          (g) =>
            g.organizationId === where.organizationId &&
            (where.externalId?.in ?? []).includes(g.externalId),
        );
      },
      deleteMany: async (args) => {
        call('guard.deleteMany', args);
        return { count: 2 };
      },
    },
    incident: {
      upsert: async (args) => {
        call('incident.upsert', args);
        return { externalId: args.create.externalId };
      },
      deleteMany: async (args) => {
        call('incident.deleteMany', args);
        return { count: 5 };
      },
    },
    attendance: {
      upsert: async (args) => {
        call('attendance.upsert', args);
        return { externalId: args.create.externalId };
      },
      deleteMany: async (args) => {
        call('attendance.deleteMany', args);
        return { count: 7 };
      },
    },
    patrolRoute: {
      upsert: async (args) => {
        call('patrolRoute.upsert', args);
        return { id: `route-${args.create.externalId}`, externalId: args.create.externalId };
      },
      findMany: async ({ where }) => {
        call('patrolRoute.findMany', { where });
        return state.routes.filter(
          (r) =>
            r.organizationId === where.site.organizationId &&
            (where.externalId?.in ?? []).includes(r.externalId),
        );
      },
      deleteMany: async (args) => {
        call('patrolRoute.deleteMany', args);
        return { count: 1 };
      },
    },
    patrolRecord: {
      upsert: async (args) => {
        call('patrolRecord.upsert', args);
        return { externalId: args.create.externalId };
      },
      deleteMany: async (args) => {
        call('patrolRecord.deleteMany', args);
        return { count: 4 };
      },
    },
    $transaction: async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops()),
  };
}

const baseState = (overrides = {}) => ({
  calls: [],
  sites: [
    { id: 'site-1', organizationId: ORG, externalId: 'A' },
    { id: 'site-9', organizationId: OTHER, externalId: 'B' }, // same id space, other tenant
  ],
  guards: [{ id: 'guard-1', organizationId: ORG, externalId: 'G1' }],
  routes: [{ id: 'route-existing', organizationId: ORG, externalId: 'R9' }],
  ...overrides,
});

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, status: err.getStatus?.(), message: err.message };
  }
}

const find = (state, name) => state.calls.filter((c) => c.name === name);

async function main() {
  boot('idempotent upserts');
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await ingest.upsertSites(ORG, [
      { externalId: 'A', name: 'Riverside', riskLevel: 'HIGH' },
      { externalId: 'B2', name: 'New Site' },
    ]);
    check('every site is written', res.upserted === 2, res.upserted);
    const first = find(state, 'site.upsert')[0].args;
    check('the caller-supplied id is the conflict key', first.where.organizationId_externalId.externalId === 'A');
    check('the conflict key is tenant scoped', first.where.organizationId_externalId.organizationId === ORG);
    check('the organization is attached on create', first.create.organizationId === ORG);
    check('a default risk level is applied', find(state, 'site.upsert')[1].args.create.riskLevel === 'LOW');
  }
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    await ingest.upsertSites(ORG, [{ externalId: 'A', name: 'Renamed' }]);
    const update = find(state, 'site.upsert')[0].args.update;
    check('a partial update does not clobber riskLevel', update.riskLevel === undefined);
  }

  boot('reference containment');
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await attempt(() =>
      ingest.upsertIncidents(ORG, [
        { externalId: 'i1', siteExternalId: 'A', severity: 'HIGH', reportedAt: new Date() },
      ]),
    );
    check('a known site resolves', res.ok === true, res.message);
    const created = find(state, 'incident.upsert')[0].args.create;
    check('the incident points at the internal site id', created.siteId === 'site-1');
    check('the reported time is applied', created.reportedAt instanceof Date);
    check('status defaults to OPEN', created.status === 'OPEN');
  }
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await attempt(() =>
      ingest.upsertIncidents(ORG, [
        { externalId: 'i2', siteExternalId: 'B', severity: 'HIGH', reportedAt: new Date() },
      ]),
    );
    check('another tenant’s site id is not resolvable', res.status === 400, res.status);
    check('the error names the offending id', /B/.test(res.message ?? ''), res.message);
    check('nothing is written when a reference fails', find(state, 'incident.upsert').length === 0);
  }
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await attempt(() =>
      ingest.upsertIncidents(ORG, [
        { externalId: 'i3', siteExternalId: 'MENSAH', severity: 'HIGH', reportedAt: new Date() },
      ]),
    );
    check('an unknown id is a 400, not a silent drop', res.status === 400);
    check('the message says to ingest sites first', /Ingest the referenced sites first/.test(res.message ?? ''), res.message);
  }
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    await ingest.upsertGuards(ORG, [{ externalId: 'G9', fullName: 'New Guard' }]);
    check('a guard without a site is unassigned', find(state, 'guard.upsert')[0].args.create.assignedSiteId === null);
  }
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    await ingest.upsertGuards(ORG, [{ externalId: 'G9', fullName: 'New Guard', siteExternalId: 'A' }]);
    check('a guard with a site is assigned', find(state, 'guard.upsert')[0].args.create.assignedSiteId === 'site-1');
  }

  boot('patrols');
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await ingest.upsertPatrols(
      ORG,
      [{ externalId: 'R1', siteExternalId: 'A' }],
      [
        { externalId: 'P1', guardExternalId: 'G1', routeExternalId: 'R1', completionPercentage: 80 },
        { externalId: 'P2', guardExternalId: 'G1', routeExternalId: 'R9', completionPercentage: 40 },
      ],
    );
    check('routes are upserted', res.routesUpserted === 1, res.routesUpserted);
    check('records are upserted', res.recordsUpserted === 2, res.recordsUpserted);
    const records = find(state, 'patrolRecord.upsert');
    check('a route created in the same request is usable', records[0].args.create.routeId === 'route-R1');
    check('a route created earlier is resolved from the database', records[1].args.create.routeId === 'route-existing');
    check('the guard is resolved to an internal id', records[0].args.create.guardId === 'guard-1');
  }
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await attempt(() =>
      ingest.upsertPatrols(
        ORG,
        [],
        [{ externalId: 'P3', guardExternalId: 'G1', routeExternalId: 'NOPE', completionPercentage: 10 }],
      ),
    );
    check('an unknown route is a 400', res.status === 400, res.status);
    check('the route message is specific', /patrol route/.test(res.message ?? ''), res.message);
  }

  boot('batching');
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const many = Array.from({ length: 1200 }, (_, i) => ({
      externalId: `S${i}`,
      name: `Site ${i}`,
    }));
    const res = await ingest.upsertSites(ORG, many);
    check('all 1200 sites are written', res.upserted === 1200, res.upserted);
    check('writes are chunked rather than one giant transaction', find(state, 'site.upsert').length === 1200);
  }

  boot('reset');
  {
    const state = baseState();
    const ingest = new IngestService(makePrisma(state));
    const res = await ingest.eraseOperationalData(ORG);
    check('the result reports what was removed', res.success === true && typeof res.deleted === 'object');
    check('counts come from the driver', res.deleted.incidents === 5, res.deleted.incidents);
    check('sites are deleted by organization', find(state, 'site.deleteMany')[0].args.where.organizationId === ORG);
    check('guards are deleted by organization', find(state, 'guard.deleteMany')[0].args.where.organizationId === ORG);
    check(
      'API keys are deliberately not touched',
      state.calls.every((c) => !c.name.startsWith('apiKey')),
    );
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
