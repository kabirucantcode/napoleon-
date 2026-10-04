# Napoleon

Standalone operational intelligence API. You feed it what happened — sites,
personnel, incidents, attendance, patrols — and it tells you what it means: a
health score, per-site risk, who needs attention, and whether a value is
unusual. It also speaks the OpenAI `chat/completions` format, so an existing chat
client can consume it by changing a base URL.

**It has no code dependency on Spectra.** Nothing here imports from another
application; `DATABASE_URL` and an API key are the whole contract.

## What it is, and what it is not

It **is** a deterministic rules engine. Every number traces back to a row you
sent, so an operator can audit it, and the same input always produces the same
output.

It is **not** a language model. It will not write prose about anything except
your operational data, and it does not guess. The OpenAI-compatible surface
renders the engine's output as markdown and puts the structured payload beside
it, so a real application can read numbers instead of parsing sentences.

## Quickstart

```bash
npm install
cp .env.example .env          # set DATABASE_URL
npm run prisma:push           # create the tables
npm run bootstrap             # create an organization + first ADMIN key
npm run start:dev
```

`bootstrap` prints the key once. Save it — only its sha256 is stored.

```bash
# Send it something to analyse
curl -X POST http://localhost:3010/api/v1/ingest/sites \
  -H "X-API-KEY: sk_napoleon_…" -H 'Content-Type: application/json' \
  -d '{"sites":[{"externalId":"riverside","name":"Riverside","riskLevel":"HIGH"}]}'

# Ask what it means
curl -H "X-API-KEY: sk_napoleon_…" \
  http://localhost:3010/api/v1/insights/overview
```

## Authentication

API keys only. There are no user accounts, sessions or passwords — it is a
service, and an organization is reached by key.

```
X-API-KEY: sk_napoleon_…             explicit
Authorization: Bearer sk_napoleon_…  what an OpenAI client sends
```

Two scopes:

| Scope | Can |
| --- | --- |
| `READ` | Read any analysis. The default when issuing. |
| `ADMIN` | Everything `READ` can, plus ingestion and key management. |

`bootstrap` issues the first `ADMIN` key. After that, manage keys with
`POST /api/v1/keys` (`{ "name", "scope" }`), `GET /api/v1/keys` (prefixes and
`lastUsedAt`, never the secret) and `DELETE /api/v1/keys/:id`.

Two deliberate refusals:

- **Key management requires `ADMIN`.** A leaked `READ` key cannot mint itself an
  `ADMIN` replacement, so privilege escalation is impossible rather than
  unlikely.
- **You cannot revoke the key you are authenticating with.** Create the
  replacement first. Losing every `ADMIN` key means re-running `bootstrap`.

## Endpoints

```
GET    /api/v1/health                      liveness, unauthenticated

GET    /api/v1/models                      OpenAI-shaped model list, public
POST   /api/v1/chat/completions            OpenAI-shaped analysis

GET    /api/v1/insights/overview           health score, KPIs, insights
GET    /api/v1/insights/risk-by-site       sites ranked by risk (30 days)
GET    /api/v1/insights/at-risk-guards     personnel flagged (14 days)

GET    /api/v1/metrics/incidents           totals, daily series, by type

POST   /api/v1/analyze                     "is this value unusual?"
POST   /api/v1/analyze/batch               many values in one round trip

POST   /api/v1/ingest/sites                upsert sites
POST   /api/v1/ingest/guards               upsert personnel
POST   /api/v1/ingest/incidents            upsert incidents
POST   /api/v1/ingest/attendance           upsert check-ins
POST   /api/v1/ingest/patrols              upsert routes and records
DELETE /api/v1/ingest/data?confirm=erase-all

POST   /api/v1/keys                        issue a key (ADMIN)
GET    /api/v1/keys                        list key prefixes (ADMIN)
DELETE /api/v1/keys/:id                    revoke one key (ADMIN)

GET    /api/v1/conversations               stored chat transcripts
GET    /api/v1/conversations/:id
DELETE /api/v1/conversations/:id
```

## Ingesting data

Every record carries **your own `externalId`**, and upserts key on
`(organization, externalId)`. That makes ingestion idempotent: send the same
batch twice and you get the same state, so "just re-send it" is always a safe
remedy. Internal ids stay internal, so one tenant's identifiers can never
collide with another's.

References are resolved **inside the calling organization only**. An
unresolvable reference is a `400` naming the missing id — never a silent drop
and never a cross-tenant link:

```
Unknown site externalId(s): riverside. Ingest the referenced sites first —
references are resolved only within your own organization.
```

Order matters on a first load: sites → guards → incidents/attendance →
patrol routes → patrol records. Patrol routes created in the same request are
usable by that request's records.

```jsonc
// POST /api/v1/ingest/incidents
{
  "incidents": [
    {
      "externalId": "inc-2026-0912",
      "siteExternalId": "riverside",
      "severity": "HIGH",        // LOW | MEDIUM | HIGH | CRITICAL
      "status": "OPEN",          // optional, defaults to OPEN
      "type": "THEFT",           // optional, caller-defined
      "reportedAt": "2026-09-12T22:15:00Z"
    }
  ]
}
```

`DELETE /api/v1/ingest/data?confirm=erase-all` wipes every operational record for
your organization. API keys and the organization survive, so a reset cannot lock
you out.

## Incident metrics

`GET /api/v1/metrics/incidents?days=30&type=THEFT`

```jsonc
{
  "window": { "from": "…", "to": "…", "days": 30 },
  "total": 412,        // every incident on record
  "inWindow": 38,      // created inside the window
  "today": 3,          // current calendar day
  "open": 7,           // currently unresolved
  "daily": [ { "date": "2026-09-01", "count": 4 } ],
  "byType": { "THEFT": 12, "TRESPASS": 5 }   // most frequent first
}
```

Filters: `?days=` (1–365), `?type=`, or an explicit `?from=&to=` ISO range.
Counting happens in the database — `count`, `groupBy`, and a single `GROUP BY`
over a date truncation — rather than being fetched and tallied in JavaScript.

## The stateless scorer

For a system that already holds its own time series and does not want its data
copied anywhere, `POST /api/v1/analyze` needs no ingestion at all: send the
history with the value.

```jsonc
// request
{ "metric": "failed_logins", "value": 47, "history": [3,4,2,5,3,…],
  "entityId": "gateway-7", "date": "2026-09-12T02:00:00Z" }

// response
{ "surprise": 0.994, "percentile": 1, "zScore": 8.2, "zLogistic": 0.994,
  "severity": "CRITICAL", "coldStart": false, "priorApplied": false,
  "sampleSize": 30, "baselineMean": 3.4, "stdDev": 1.1, "weekdayMean": 4.1 }
```

Reads and writes nothing. `prior` lets a caller blend a thin history toward a
known baseline (`{ "mean": 3, "stdDev": 1.2 }`), which is how a new entity is
not blind for its first month.

## Using it like ChatGPT

```js
import OpenAI from "openai";

const napoleon = new OpenAI({
  baseURL: "http://localhost:3010/api/v1",
  apiKey: process.env.NAPOLEON_KEY,
});

const res = await napoleon.chat.completions.create({
  model: "napoleon-risk",
  messages: [{ role: "user", content: "Which site worries you most?" }],
});

res.choices[0].message.content;            // markdown report
res.choices[0].message.napoleon.analysis;  // the numbers behind it
```

`model` selects the analysis: `napoleon-1`/`napoleon-pro` → overview,
`napoleon-risk` → site risk, `napoleon-guards` → at-risk personnel. Any other
name — including `gpt-4o`, which wrappers default to — routes on your message
text instead, so a generic wrapper still returns something sensible.

`stream: true` emits real SSE ending in `data: [DONE]`. Extra request fields
(`temperature`, `top_p`, `tools`, …) are accepted and ignored rather than
rejected, so real SDK calls do not 400. Errors use the OpenAI envelope. `usage`
is estimated (~4 chars/token) because there is no tokenizer.

## The engine

### Overview

Windows: 30 days for incidents, 14 for attendance and patrols.

```
healthScore = weighted mean of the components that have data:
  avgPerformance     × 0.40   (only if personnel exist)
  (100 − open×3)     × 0.25   (always — zero open incidents is a real result)
  (100 − lateRate)   × 0.20   (only if attendance exists)
  patrolCompletion   × 0.15   (only if patrol history exists)
```

**Absent data is excluded, not scored as zero.** A missing metric has no
completion rate and no lateness rate; treating its default of `0` as a failure
would report a patrol problem for an organization that has never run a patrol,
and would drag the health score down for data that simply has not arrived yet.
The remaining weights are renormalised, so the score still means "over the inputs
I have".

The response carries `dataStatus` so a caller knows how to read that score:

| Value | Meaning |
| --- | --- |
| `OK` | Every input has data. The score is comparable. |
| `PARTIAL` | Some inputs are empty. The score covers only what exists — do not compare it to a fully-instrumented organization. |
| `EMPTY` | Nothing ingested. `healthScore` is `0` and no metric is meaningful. |

An `EMPTY` organization and a catastrophic one both have numbers near zero and
mean opposite things, which is why the flag exists rather than making callers
infer it. On `EMPTY` the single insight explains what to send first, and the
markdown surface prints "Nothing has been ingested yet" instead of a KPI table.

Insights fire on: ≥3 open incidents (HIGH); late rate >20% (only with attendance
data); patrol completion <80% (only with patrol data); >50% of incidents between
18:00–06:00; any personnel scoring below 60 (HIGH when more than three). If
nothing fires, one INFO insight says so rather than returning an empty list.

### Site risk (30 days)

```
riskScore = clamp(
  min(Σ severityWeight, 60)          CRITICAL 40, HIGH 25, MEDIUM 12, LOW 5
  + lateRate × 0.25
  + (100 − patrolCompletion) × 0.35
  + declaredRiskBonus                CRITICAL 10, HIGH 6, MEDIUM 3
)
```

Sites sort most exposed first, with `incidentCount30d`, `openIncidents30d`,
`peakIncidentHour` and the two rates alongside.

### Personnel risk (14 days)

`late ≥ 3` → MEDIUM · `absent ≥ 2` → MEDIUM/HIGH · geofence flags ≥ 2 →
MEDIUM/HIGH · `performanceScore < 60` → HIGH. Only non-LOW rows are returned,
each with the human-readable reasons that put it there.

## Client

A zero-dependency client lives in [`sdk/`](sdk/), with the same namespaces as the
API and correct paths (the Spectra-era client pointed at `/napoleon/*` and will
404 against this service):

```js
const { NapoleonClient } = require('napoleon-client');

const napoleon = new NapoleonClient({
  baseUrl: 'https://your-host/api/v1',
  apiKey: process.env.NAPOLEON_KEY,
});

await napoleon.ingest.sites([{ externalId: 'riverside', name: 'Riverside' }]);
const health = await napoleon.insights.overview();
if (health.dataStatus !== 'EMPTY') console.log(health.healthScore);
```

See [`sdk/README.md`](sdk/README.md) for the full surface, and
`sdk/examples/quickstart.js` for an end-to-end walkthrough that ingests a small
complete dataset and reads every view back.

## Layout

```
sdk/                          zero-dependency client + types + example
src/
  main.ts                     bootstrap, global prefix, CORS
  app.module.ts               four modules, nothing else
  database/                   the only database this app knows about
  engine/
    insights.service.ts       the engine — pure data in, pure data out
    surprise.ts               scoring against a history
    stats.ts                  descriptive statistics
    baseline-store.ts         storage port (swap the history source)
  openai/openai.renderer.ts   wire format; the only place that knows OpenAI
  auth/                       keys, scopes, one authentication path
  modules/
    insights.controller.ts    the structured read surface
    metrics.controller.ts     incident aggregation
    analyze.controller.ts     the stateless scorer
    openai.controller.ts      chat/completions, models, conversations
    ingest.*                  writing records in
    intelligence.module.ts    everything a caller reads
    ingest.module.ts          everything a caller writes
  scripts/                    bootstrap + the smoke suite
prisma/schema.prisma
```

`insights.service.ts` and `openai.renderer.ts` were ported from Spectra
unchanged, because the schema deliberately reproduces the field names they read.
Formatting lives only in the renderer, so the wire format can change without
touching a rule.

## Verifying it

```bash
npm run build
npm run smoke
```

The smoke suite stubs the database so the logic can be exercised without
Postgres:

- **engine** — the arithmetic against a fixture, including windowing,
  organization scoping, and the empty/partial-data behaviour
- **anomaly** — scoring math, prior shrinkage, weekday awareness, `/analyze`
  validation
- **openai** — the envelope, SSE reassembly, error bodies, intent routing
- **auth** — the credential matrix and scope enforcement, including that a `READ`
  key cannot mint an `ADMIN` one
- **ingest** — containment (another tenant's id is never resolvable), idempotent
  upserts, chunking
- **sdk** — every client method asserted against the server's method and path,
  so a drifting route fails here rather than in someone's integration

It is the check that runs in CI without a database. It is not a substitute for
one end-to-end run against real Postgres.

## Deploying

`Dockerfile` and `render.yaml` are included. The container runs
`prisma db push` then the server, so a single service is enough. Once the schema
is stable, switch to `prisma migrate deploy` and commit migrations.

Set `DATABASE_URL` and, if a browser will call it, `CORS_ORIGIN` (comma
separated). Server-to-server callers are unaffected by CORS — they do not
preflight. Run `npm run bootstrap` once against the deployed database.

## Not included

Deliberately out of scope, and honest about it:

- **No alerting pipeline.** There is scoring, but nothing that runs rules on a
  schedule, persists alerts, or queues notifications. That is a different
  product surface and needs Redis.
- **No learned model.** The ranking model that would reorder alerts by what
  operators actually act on needs labelled history. `Conversation`/`Message`
  exist so that record can be built later.
- **No frontend.** This is the API.
