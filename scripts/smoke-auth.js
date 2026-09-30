'use strict';

/**
 * Access-control smoke test.
 *
 * The guard and key service are plain classes, so both are instantiated with
 * stubbed Prisma and a stubbed Reflector. That covers the whole credential
 * matrix — including scope enforcement — with no database.
 *
 *   node scripts/smoke-auth.js
 */

const { boot, check, summary, requireDist } = require('./_harness');

const { createHash } = require('crypto');
const { ApiKeyGuard } = requireDist('auth/api-key.guard');
const { KeysService } = requireDist('auth/keys.service');

const ORG = 'org-1';
const KEY = 'sk_napoleon_abc123';
const READ_KEY = 'sk_napoleon_readonly';
const ADMIN_KEY = 'sk_napoleon_admin';
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

function makePrisma(state) {
  return {
    apiKey: {
      findUnique: async ({ where }) => state.keys[where.keyHash] ?? null,
      findFirst: async ({ where }) => state.keyRows.find((k) => k.id === where.id && k.organizationId === where.organizationId) ?? null,
      create: async ({ data }) => {
        state.created.push(data);
        return { id: 'key-new', ...data };
      },
      update: ({ where, data }) => {
        state.updates.push({ where, data });
        return Promise.resolve({});
      },
      findMany: async () => state.keyRows,
    },
  };
}

/** Stand-in for Nest's Reflector: returns whatever scope the test declares. */
function makeReflector(requiredScope) {
  return { getAllAndOverride: () => requiredScope };
}

const ctxFor = (req) => ({
  switchToHttp: () => ({ getRequest: () => req }),
  getHandler: () => () => undefined,
  getClass: () => class {},
});

function baseState() {
  return {
    keys: {
      [sha256(READ_KEY)]: { id: 'k-read', name: 'reader', isActive: true, scope: 'READ', organizationId: ORG, organization: { isActive: true } },
      [sha256(ADMIN_KEY)]: { id: 'k-admin', name: 'writer', isActive: true, scope: 'ADMIN', organizationId: ORG, organization: { isActive: true } },
      [sha256('sk_napoleon_revoked')]: { id: 'k-dead', name: 'old', isActive: false, scope: 'ADMIN', organizationId: ORG, organization: { isActive: true } },
      [sha256('sk_napoleon_deadorg')]: { id: 'k-deadorg', name: 'deadorg', isActive: true, scope: 'ADMIN', organizationId: ORG, organization: { isActive: false } },
    },
    keyRows: [
      { id: 'k-read', organizationId: ORG, name: 'reader', prefix: 'sk_napoleon_read', scope: 'READ', isActive: true, lastUsedAt: null, createdAt: new Date() },
      { id: 'k-other', organizationId: 'org-2', name: 'someone else', prefix: 'sk_napoleon_othe', scope: 'ADMIN', isActive: true, lastUsedAt: null, createdAt: new Date() },
    ],
    updates: [],
    created: [],
  };
}

async function attempt(guard, req) {
  try {
    return { ok: await guard.canActivate(ctxFor(req)) };
  } catch (err) {
    return { ok: false, status: err.getStatus?.(), message: err.message };
  }
}

async function main() {
  boot('credential transports');
  {
    const state = baseState();
    const guard = new ApiKeyGuard(makePrisma(state), makeReflector(undefined));
    const res = await attempt(guard, { headers: { 'x-api-key': READ_KEY } });
    check('X-API-Key authenticates', res.ok === true);
    check('the organization is resolved from the key', res.ok && state.updates.length === 1);
  }
  {
    const state = baseState();
    const guard = new ApiKeyGuard(makePrisma(state), makeReflector(undefined));
    const req = { headers: { authorization: `Bearer ${ADMIN_KEY}` } };
    const res = await attempt(guard, req);
    check('an OpenAI-style bearer key authenticates', res.ok === true);
    check('the principal carries the organization', req.principal?.organizationId === ORG);
    check('the principal carries the scope', req.principal?.scope === 'ADMIN');
    await new Promise((r) => setImmediate(r));
    check('last-used is recorded', state.updates[0]?.where?.id === 'k-admin');
    check('last-used is a timestamp', state.updates[0]?.data?.lastUsedAt instanceof Date);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    const req = { headers: { 'x-api-key': [READ_KEY, 'ignored'] } };
    check('a repeated header uses the first value', (await attempt(guard, req)).ok === true);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check(
      'Bearer scheme is case-insensitive',
      (await attempt(guard, { headers: { authorization: `bearer ${READ_KEY}` } })).ok === true,
    );
  }

  boot('rejections');
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    const res = await attempt(guard, { headers: {} });
    check('no credential is a 401', res.status === 401, res.status);
    check('the error explains the header format', /X-API-Key|Bearer/.test(res.message ?? ''));
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check('an unknown key is a 401', (await attempt(guard, { headers: { 'x-api-key': 'nope' } })).status === 401);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check('a revoked key is a 401', (await attempt(guard, { headers: { 'x-api-key': 'sk_napoleon_revoked' } })).status === 401);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check('a key on a disabled organization is a 401', (await attempt(guard, { headers: { 'x-api-key': 'sk_napoleon_deadorg' } })).status === 401);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check('a non-bearer authorization header is a 401', (await attempt(guard, { headers: { authorization: 'Basic dXNlcjpwYXNz' } })).status === 401);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check('a bare "Bearer" is a 401', (await attempt(guard, { headers: { authorization: 'Bearer' } })).status === 401);
  }

  boot('scope enforcement');
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector('ADMIN'));
    const res = await attempt(guard, { headers: { 'x-api-key': READ_KEY } });
    check('a READ key is refused on an ADMIN route', res.status === 403, res.status);
    check('the refusal names the supplied scope', /READ/.test(res.message ?? ''));
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector('ADMIN'));
    check('an ADMIN key passes an ADMIN route', (await attempt(guard, { headers: { 'x-api-key': ADMIN_KEY } })).ok === true);
  }
  {
    const guard = new ApiKeyGuard(makePrisma(baseState()), makeReflector(undefined));
    check('a READ key passes an unrestricted route', (await attempt(guard, { headers: { 'x-api-key': READ_KEY } })).ok === true);
  }
  {
    // Escalation check: a READ key must not be able to reach key management,
    // which is the route that mints ADMIN keys.
    const state = baseState();
    const guard = new ApiKeyGuard(makePrisma(state), makeReflector('ADMIN'));
    const res = await attempt(guard, { headers: { 'x-api-key': READ_KEY } });
    check('a READ key cannot reach key management', res.status === 403);
    check('no key was created by the attempt', state.created.length === 0);
  }

  boot('KeysService');
  {
    const state = baseState();
    const keys = new KeysService(makePrisma(state));
    const issued = await keys.create(ORG, 'Warehouse dashboard', 'READ');
    check('the plaintext carries the service prefix', issued.apiKey.startsWith('sk_napoleon_'), issued.apiKey);
    check('the prefix is 16 characters', issued.prefix.length === 16, issued.prefix);
    check('the plaintext is not stored', state.created[0].keyHash !== issued.apiKey);
    check('the stored value is the sha256 of the key', state.created[0].keyHash === sha256(issued.apiKey));
    check('the key is scoped to the organization', state.created[0].organizationId === ORG);
    check('the requested scope is applied', state.created[0].scope === 'READ');
    check('a warning accompanies the secret', typeof issued.warning === 'string');
    check('enough entropy is present', issued.apiKey.length > 40, issued.apiKey.length);
  }
  {
    const state = baseState();
    const keys = new KeysService(makePrisma(state));
    const first = await keys.create(ORG, 'a', 'READ');
    const second = await keys.create(ORG, 'b', 'READ');
    check('two keys are distinct', first.apiKey !== second.apiKey);
  }
  {
    const keys = new KeysService(makePrisma(baseState()));
    const list = await keys.list(ORG);
    check('list returns rows', list.length === 2, list.length);
    check('list never exposes a secret', list.every((k) => k.apiKey === undefined && typeof k.prefix === 'string'));
  }
  {
    const keys = new KeysService(makePrisma(baseState()));
    const res = await keys
      .revoke(ORG, 'k-read', 'k-read')
      .then(() => ({ status: 200 }))
      .catch((err) => ({ status: err.getStatus?.() }));
    check('revoking the calling key is refused', res.status === 409, res.status);
  }
  {
    const keys = new KeysService(makePrisma(baseState()));
    const res = await keys
      .revoke(ORG, 'k-other', 'k-read')
      .then(() => ({ status: 200 }))
      .catch((err) => ({ status: err.getStatus?.() }));
    check('another organization’s key is a 404, not a revocation', res.status === 404, res.status);
  }
  {
    const state = baseState();
    const keys = new KeysService(makePrisma(state));
    const res = await keys.revoke(ORG, 'k-read', 'k-admin');
    check('revoking another own key succeeds', res.success === true);
    check('revocation deactivates rather than deletes', state.updates[0]?.data?.isActive === false);
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
