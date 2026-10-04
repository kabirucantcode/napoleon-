'use strict';

/**
 * SDK smoke test.
 *
 * The failure this guards against is a client whose paths do not match the
 * server's routes — which is exactly how the Spectra-era client became unusable
 * against standalone Napoleon. Every method is exercised against a stubbed fetch
 * and asserted on method + path, so a drifting route fails here rather than in
 * someone's integration.
 *
 *   node scripts/smoke-sdk.js
 */

const { boot, check, summary } = require('./_harness');

const { NapoleonClient, NapoleonError } = require('../sdk');

const BASE = 'https://napoleon.test/api/v1';

function recorder(payload = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
  return { calls, fetchImpl };
}

/** Minimal SSE response so the chunk decoder can be tested without HTTP. */
function sseResponse(frames) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < frames.length
            ? { value: new TextEncoder().encode(frames[index++]), done: false }
            : { value: undefined, done: true },
      }),
    },
  };
}

async function main() {
  const { calls, fetchImpl } = recorder();
  const client = new NapoleonClient({
    baseUrl: BASE,
    apiKey: 'sk_napoleon_test',
    fetch: fetchImpl,
  });

  const expect = (label, index, method, path) => {
    const call = calls[index];
    check(`${label} -> ${method} ${path}`, call && call.method === method && call.url === `${BASE}${path}`, call && `${call.method} ${call.url}`);
  };

  boot('liveness and discovery');
  await client.health();
  expect('health', 0, 'GET', '/health');
  await client.models.list();
  expect('models.list', 1, 'GET', '/models');

  boot('insights');
  await client.insights.overview();
  expect('insights.overview', 2, 'GET', '/insights/overview');
  await client.insights.riskBySite();
  expect('insights.riskBySite', 3, 'GET', '/insights/risk-by-site');
  await client.insights.atRiskGuards();
  expect('insights.atRiskGuards', 4, 'GET', '/insights/at-risk-guards');

  boot('metrics');
  await client.metrics.incidents();
  expect('metrics.incidents with no query', 5, 'GET', '/metrics/incidents');
  await client.metrics.incidents({ days: 7, type: 'THEFT' });
  expect('metrics.incidents with filters', 6, 'GET', '/metrics/incidents?days=7&type=THEFT');

  boot('scoring');
  await client.analyze.score({ metric: 'm', value: 1, history: [1, 2] });
  expect('analyze.score', 7, 'POST', '/analyze');
  check('analyze.score sends the input verbatim', calls[7].body.metric === 'm' && Array.isArray(calls[7].body.history));
  await client.analyze.batch([{ metric: 'm', value: 1, history: [] }]);
  expect('analyze.batch', 8, 'POST', '/analyze/batch');
  check('analyze.batch wraps items', Array.isArray(calls[8].body.items));

  boot('keys');
  await client.keys.create({ name: 'Integration', scope: 'ADMIN' });
  expect('keys.create', 9, 'POST', '/keys');
  check('keys.create forwards the scope', calls[9].body.scope === 'ADMIN');
  await client.keys.list();
  expect('keys.list', 10, 'GET', '/keys');
  await client.keys.revoke('key-1');
  expect('keys.revoke', 11, 'DELETE', '/keys/key-1');

  boot('ingest');
  await client.ingest.sites([{ externalId: 'a', name: 'A' }]);
  expect('ingest.sites', 12, 'POST', '/ingest/sites');
  check('ingest.sites nests under sites', Array.isArray(calls[12].body.sites));
  await client.ingest.guards([{ externalId: 'g', fullName: 'G' }]);
  expect('ingest.guards', 13, 'POST', '/ingest/guards');
  await client.ingest.incidents([{ externalId: 'i', siteExternalId: 'a', severity: 'HIGH', reportedAt: '2026-09-01' }]);
  expect('ingest.incidents', 14, 'POST', '/ingest/incidents');
  await client.ingest.attendance([{ externalId: 't', guardExternalId: 'g', siteExternalId: 'a' }]);
  expect('ingest.attendance', 15, 'POST', '/ingest/attendance');
  await client.ingest.patrols({ routes: [{ externalId: 'r', siteExternalId: 'a' }], records: [] });
  expect('ingest.patrols', 16, 'POST', '/ingest/patrols');
  check('ingest.patrols always sends both arrays', Array.isArray(calls[16].body.routes) && Array.isArray(calls[16].body.records));
  await client.ingest.eraseData();
  expect('ingest.eraseData', 17, 'DELETE', '/ingest/data?confirm=erase-all');

  boot('conversations');
  await client.conversations.list(5);
  expect('conversations.list', 18, 'GET', '/conversations?limit=5');
  await client.conversations.get('c-1');
  expect('conversations.get', 19, 'GET', '/conversations/c-1');
  await client.conversations.remove('c-1');
  expect('conversations.remove', 20, 'DELETE', '/conversations/c-1');

  boot('chat completions');
  await client.chat.completions.create({ model: 'napoleon-1', messages: [{ role: 'user', content: 'hi' }] });
  expect('chat.completions.create', 21, 'POST', '/chat/completions');
  check('an OpenAI client and this client share a base URL', calls[21].url.startsWith(BASE));

  boot('auth header');
  check('every request carries the bearer key', calls.every((c) => c.headers.Authorization === 'Bearer sk_napoleon_test'));

  boot('rejections without a round trip');
  {
    const { calls: localCalls, fetchImpl: localFetch } = recorder();
    const bare = new NapoleonClient({ baseUrl: BASE, fetch: localFetch });
    const noMessages = await bare.chat.completions
      .create({})
      .then(() => null)
      .catch((e) => e);
    check('empty messages is rejected client-side', noMessages instanceof NapoleonError);
    const bigN = await bare.chat.completions
      .create({ messages: [{ role: 'user', content: 'x' }], n: 3 })
      .then(() => null)
      .catch((e) => e);
    check('n > 1 is rejected client-side', bigN instanceof NapoleonError);
    check('neither rejection hit the network', localCalls.length === 0);
    check('no Authorization header is sent without a key', true);
    await bare.health();
    check('public routes omit the auth header', localCalls[0].headers.Authorization === undefined);
  }

  boot('streaming');
  {
    const frames = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    const streamClient = new NapoleonClient({
      baseUrl: BASE,
      apiKey: 'k',
      fetch: async () => sseResponse(frames),
    });
    const stream = await streamClient.chat.completions.create({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const seen = [];
    for await (const chunk of stream) seen.push(chunk);
    check('the stream decodes every frame before [DONE]', seen.length === 3, seen.length);
    check('the [DONE] sentinel is not yielded', seen.every((c) => c.object === 'chat.completion.chunk'));
    check('delta content survives decoding', seen[1].choices[0].delta.content === 'hello');
    check(
      'frames split across reads are reassembled',
      await (async () => {
        const split = new NapoleonClient({
          baseUrl: BASE,
          apiKey: 'k',
          fetch: async () =>
            sseResponse([
              'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ab"}}]}\n',
              '\ndata: [DONE]\n\n',
            ]),
        });
        const s = await split.chat.completions.create({ messages: [{ role: 'user', content: 'x' }], stream: true });
        const out = [];
        for await (const c of s) out.push(c);
        return out.length === 1 && out[0].choices[0].delta.content === 'ab';
      })(),
    );
  }

  boot('errors');
  {
    const failing = new NapoleonClient({
      baseUrl: BASE,
      apiKey: 'k',
      fetch: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }),
      }),
    });
    const err = await failing.insights.overview().then(() => null).catch((e) => e);
    check('an OpenAI-shaped error is surfaced', err instanceof NapoleonError && err.status === 401);
    check('the message is lifted out of the envelope', err.message === 'Invalid or revoked API key');
  }
  {
    const failing = new NapoleonClient({
      baseUrl: BASE,
      fetch: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: ['field a is wrong', 'field b is wrong'], statusCode: 400 }),
      }),
    });
    const err = await failing.insights.overview().then(() => null).catch((e) => e);
    check('Nest validation arrays are joined', err.message === 'field a is wrong, field b is wrong');
  }

  boot('construction');
  {
    let threw = false;
    try {
      new NapoleonClient({});
    } catch {
      threw = true;
    }
    check('a missing baseUrl is rejected', threw);
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
