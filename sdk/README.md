# napoleon-client

Client for the [Napoleon API](../README.md). Zero dependencies — one file, using
the global `fetch`, so it runs on Node 18+, Deno, Bun, browsers and workers.

```bash
npm install napoleon-client
```

## Setup

```js
const { NapoleonClient } = require('napoleon-client');

const napoleon = new NapoleonClient({
  baseUrl: 'https://your-host/api/v1',   // the API root
  apiKey: process.env.NAPOLEON_KEY,      // sk_napoleon_…
});
```

`baseUrl` is the API root, **not** a chat path. The OpenAI-compatible endpoint
lives at the root of this API, so an OpenAI client points at the same value:

```js
new OpenAI({ baseURL: 'https://your-host/api/v1', apiKey: process.env.NAPOLEON_KEY });
```

Requires a key from `POST /api/v1/keys` (or `npm run bootstrap` once). Key
management and ingestion need an `ADMIN` key; everything read-only works with
`READ`.

## Reading

```js
await napoleon.insights.overview();      // health score, KPIs, insights
await napoleon.insights.riskBySite();    // sites ranked by risk
await napoleon.insights.atRiskGuards();  // personnel flagged, with reasons

await napoleon.metrics.incidents({ days: 30, type: 'THEFT' });
// { total, inWindow, today, open, daily: [...], byType: { THEFT: 12 } }
```

### `dataStatus` matters

`overview()` reports what it actually knows:

| Value | Meaning |
| --- | --- |
| `OK` | Every input has data. The score is comparable. |
| `PARTIAL` | Some sources are empty. The score is computed only over the inputs that exist, so **do not compare it** to a fully-instrumented organization. |
| `EMPTY` | Nothing ingested. `healthScore` is `0` and no metric is meaningful — read the single guidance insight instead of the numbers. |

Check it before displaying a score. An `EMPTY` organization and a
catastrophically unhealthy one both have numbers near zero, and they mean
opposite things.

```js
const health = await napoleon.insights.overview();
if (health.dataStatus === 'EMPTY') {
  console.log(health.insights[0].recommendation);  // what to send first
} else {
  console.log(health.healthScore, health.dataStatus);
}
```

## Scoring without ingesting

`analyze` is stateless: send the history with the value, and nothing is stored.
Useful when you already have your own time series and don't want it copied.

```js
await napoleon.analyze.score({
  metric: 'failed_logins',
  value: 47,
  history: [3, 4, 2, 5, 3 /* … */],
  entityId: 'gateway-7',
  date: '2026-09-12T02:00:00Z',
  prior: { mean: 3, stdDev: 1.2 },   // optional: steadies a thin history
});
// { surprise: 0.994, severity: 'CRITICAL', percentile: 1, coldStart: false, … }
```

`analyze.batch([...])` scores many in one round trip. A malformed item is
returned in place as `{ index, error }` rather than failing the batch.

## Ingesting

```js
await napoleon.ingest.sites([{ externalId: 'riverside', name: 'Riverside', riskLevel: 'HIGH' }]);
await napoleon.ingest.guards([{ externalId: 'g-1', fullName: 'A. Operator', siteExternalId: 'riverside' }]);
await napoleon.ingest.incidents([{
  externalId: 'inc-1', siteExternalId: 'riverside',
  severity: 'HIGH', type: 'THEFT', reportedAt: '2026-09-12T22:15:00Z',
}]);
await napoleon.ingest.attendance([{
  externalId: 'att-1', guardExternalId: 'g-1', siteExternalId: 'riverside',
  createdAt: '2026-09-12T06:00:00Z', isLate: false,
}]);
await napoleon.ingest.patrols({
  routes: [{ externalId: 'route-1', siteExternalId: 'riverside' }],
  records: [{ externalId: 'pr-1', guardExternalId: 'g-1', routeExternalId: 'route-1', completionPercentage: 80 }],
});
```

Two properties make this safe to replay:

- **Every row is keyed on your own `externalId`** within your organization, so
  sending a batch twice gives the same state. Re-sending after a failure is
  always the right move.
- **References resolve inside your organization only.** An `externalId` that
  belongs to someone else is a `400` naming it, never a silent drop. Load order
  on a first run: sites → guards → incidents/attendance → patrols.

A single request takes up to 5000 records; larger runs are chunked per endpoint.

`ingest.eraseData()` wipes every operational record. API keys and the
organization survive, so a reset can't lock you out.

## Managing keys

```js
const { apiKey } = await napoleon.keys.create({ name: 'Warehouse dashboard', scope: 'READ' });
// apiKey is returned once — only its sha256 is stored

await napoleon.keys.list();       // prefixes and lastUsedAt, never the secret
await napoleon.keys.revoke(id);   // revokes one; refuses the key you are using
```

## Chat-shaped access

```js
const res = await napoleon.chat.completions.create({
  model: 'napoleon-risk',
  messages: [{ role: 'user', content: 'Which site worries you most?' }],
});
res.choices[0].message.content;            // markdown
res.choices[0].message.napoleon.analysis;  // the numbers behind it
```

`model` picks the analysis: `napoleon-1` → overview, `napoleon-risk` → site risk,
`napoleon-guards` → flagged personnel. Any other name (including `gpt-4o`) routes
on the prompt instead. Streaming works:

```js
const stream = await napoleon.chat.completions.create({ messages: [...], stream: true });
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

## Errors

Every failure throws `NapoleonError` with `.status` and `.body`. Messages come
from the API, so they say what to do:

```js
try {
  await napoleon.ingest.incidents(rows);
} catch (err) {
  err.status;   // 400
  err.message;  // "Unknown site externalId(s): riverside. Ingest the referenced sites first"
}
```

`messages` and `n > 1` are rejected client-side without a network round trip.

## Not installing from npm?

It's a single zero-dependency file. Either install from a path or vendor it:

```bash
npm install /path/to/napoleon/sdk
```
