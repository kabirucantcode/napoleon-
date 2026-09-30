'use strict';

/**
 * OpenAI-compatibility smoke test.
 *
 * Drives the real `OpenAiController` with a stub response object, so the wire
 * format — envelope, SSE frames, error bodies — is verified without HTTP.
 *
 *   node scripts/smoke-openai.js
 */

const { boot, check, summary, requireDist } = require('./_harness');

const { OpenAiRenderer, estimateTokens } = requireDist('openai/openai.renderer');
const { OpenAiController } = requireDist('modules/openai.controller');

const overview = {
  generatedAt: '2026-09-29T10:00:00.000Z',
  healthScore: 78,
  openIncidents: 4,
  avgGuardPerformance: 72,
  lateCheckInRate: 23.1,
  patrolCompletionRate: 81.4,
  atRiskGuardCount: 5,
  siteCount: 12,
  insights: [
    {
      severity: 'HIGH',
      category: 'INCIDENTS',
      title: '4 open incidents need attention',
      detail: 'Response has not closed 4 incident(s).',
      recommendation: 'Assign owners and escalate anything over 48 hours old.',
      metric: '4 open',
    },
    {
      severity: 'MEDIUM',
      category: 'ATTENDANCE',
      title: 'Late check-ins running at 23%',
      detail: 'More than 1 in 5 check-ins was late.',
      recommendation: 'Review shift start times.',
      metric: '23%',
    },
    {
      severity: 'INFO',
      category: 'HEALTH',
      title: 'Other systems nominal',
      detail: 'No other anomalies.',
      recommendation: 'Carry on.',
      metric: 'ok',
    },
  ],
};

const riskBySite = [
  { siteId: 's1', siteName: 'Riverside', riskLevel: 'CRITICAL', riskScore: 87, incidentCount30d: 9, openIncidents30d: 3, lateCheckInRate: 18.2, patrolCompletionRate: 62.1, peakIncidentHour: 22 },
  { siteId: 's2', siteName: 'Okonkwo Plaza', riskLevel: 'LOW', riskScore: 12, incidentCount30d: 0, openIncidents30d: 0, lateCheckInRate: 0, patrolCompletionRate: 100, peakIncidentHour: null },
];

const atRiskGuards = [
  { guardId: 'g1', fullName: 'Emeka Obi', shift: 'NIGHT', site: 'Riverside', performanceScore: 54, reliability: 76, lateCount: 4, absentCount: 2, flaggedCount: 0, riskLevel: 'HIGH', riskFactors: ['4 late check-ins', 'score 54'] },
];

const engine = {
  getOverview: async () => overview,
  getRiskBySite: async () => riskBySite,
  getAtRiskGuards: async () => atRiskGuards,
};

function fakeRes() {
  const state = { headers: {}, body: undefined, frames: [], ended: false };
  return {
    state,
    setHeader: (k, v) => {
      state.headers[k] = v;
    },
    flushHeaders: () => {
      state.flushed = true;
    },
    json: (payload) => {
      state.body = payload;
    },
    write: (frame) => {
      state.frames.push(frame);
    },
    end: () => {
      state.ended = true;
    },
  };
}

function attempt(promise) {
  return promise
    .then(() => ({ ok: true }))
    .catch((err) => ({
      ok: false,
      status: err.getStatus?.(),
      response: err.getResponse?.(),
    }));
}

async function main() {
  const renderer = new OpenAiRenderer(engine);

  // ── Models ────────────────────────────────────────────────────────────────
  boot('model registry');
  const models = renderer.listModels();
  check('shaped as an OpenAI list', models.object === 'list' && Array.isArray(models.data));
  check('every entry is an object of type model', models.data.every((m) => m.object === 'model' && m.owned_by === 'spectra'));
  check('intents are exposed for integrators', models.data.every((m) => typeof m.napoleon?.intent === 'string'));
  check('generic OpenAI names are accepted', renderer.supportedModelIds().includes('gpt-4o'));

  // ── Intent routing ────────────────────────────────────────────────────────
  boot('intent routing');
  check('napoleon-risk is explicit', renderer.resolveIntent('napoleon-risk', '') === 'risk_by_site');
  check('napoleon-guards is explicit', renderer.resolveIntent('napoleon-guards', '') === 'at_risk_guards');
  check('napoleon-1 is the overview', renderer.resolveIntent('napoleon-1', '') === 'overview');
  check('a risk question routes to site risk', renderer.resolveIntent('gpt-4o', 'which site is riskiest?') === 'risk_by_site');
  check('a personnel question routes to guards', renderer.resolveIntent('gpt-4o-mini', 'who are the underperforming guards?') === 'at_risk_guards');
  check('a vague question falls back to the overview', renderer.resolveIntent('some-proxy', 'hello') === 'overview');
  check('an unknown napoleon-* name is the overview', renderer.resolveIntent('napoleon-max', '') === 'overview');

  // ── Rendering ─────────────────────────────────────────────────────────────
  boot('rendering');
  const overviewMd = renderer.render('overview', overview);
  check('the health score is shown', overviewMd.includes('78/100'));
  check('insights are numbered as a list', overviewMd.includes('### Insights'));
  check('recommendations are included', overviewMd.includes('Assign owners'));
  check('a disclaimer names the engine', overviewMd.toLowerCase().includes('not a language model'));

  const riskMd = renderer.render('risk_by_site', riskBySite);
  check('sites are ranked worst first', riskMd.indexOf('Riverside') < riskMd.indexOf('Okonkwo'));
  check('a null peak hour renders as a dash', riskMd.includes('—'));
  check('the peak hour is zero padded', riskMd.includes('22:00'));

  const guardsMd = renderer.render('at_risk_guards', atRiskGuards);
  check('guards are rendered by name', guardsMd.includes('Emeka Obi'));
  check('risk factors are listed', guardsMd.includes('4 late check-ins'));

  check('an empty guard list reads sensibly', renderer.render('at_risk_guards', []).includes('No guards are flagged'));
  check('an empty site list reads sensibly', renderer.render('risk_by_site', []).includes('No sites'));
  check('an empty insight list is not possible, but a guard empty-state is stable', renderer.render('at_risk_guards', []).length > 40);

  // ── Envelope ──────────────────────────────────────────────────────────────
  boot('chat.completion envelope');
  const completion = renderer.buildCompletion({
    id: 'chatcmpl-test',
    created: 1789000000,
    model: 'napoleon-1',
    intent: 'overview',
    data: overview,
    content: overviewMd,
    promptTokens: 12,
  });
  check('object is chat.completion', completion.object === 'chat.completion');
  check('one choice, finish_reason stop', completion.choices.length === 1 && completion.choices[0].finish_reason === 'stop');
  check('role is assistant', completion.choices[0].message.role === 'assistant');
  check('content is the markdown', completion.choices[0].message.content === overviewMd);
  check('the structured payload rides alongside', completion.choices[0].message.napoleon.analysis.healthScore === 78);
  check('the intent is echoed', completion.choices[0].message.napoleon.intent === 'overview');
  check('usage is internally consistent', completion.usage.total_tokens === completion.usage.prompt_tokens + completion.usage.completion_tokens);
  check('a fingerprint is present', typeof completion.system_fingerprint === 'string');

  // ── SSE ───────────────────────────────────────────────────────────────────
  boot('streaming');
  const frames = renderer.streamChunks(completion, 'conv-1');
  check('the stream terminates with [DONE]', frames[frames.length - 1] === 'data: [DONE]\n\n');
  check('every frame is a single SSE data line', frames.every((f) => f.startsWith('data: ') && f.endsWith('\n\n')));

  const parsed = frames.slice(0, -1).map((f) => JSON.parse(f.slice(6)));
  check('the first frame opens the assistant turn', parsed[0].choices[0].delta.role === 'assistant');
  check('chunks are typed as chunks', parsed.every((p) => p.object === 'chat.completion.chunk' || p.object === undefined));
  check('a finish_reason of stop is emitted', parsed.some((p) => p.choices[0] && p.choices[0].finish_reason === 'stop'));
  check('the conversation id is threaded through', parsed.every((p) => p.napoleon_conversation_id === 'conv-1'));

  const reassembled = parsed
    .map((p) => (p.choices[0] && p.choices[0].delta && p.choices[0].delta.content) || '')
    .join('');
  check('deltas reassemble to the exact markdown', reassembled === overviewMd);

  check('tokens are estimated from length', estimateTokens('a'.repeat(400)) === 100);

  // ── Controller ────────────────────────────────────────────────────────────
  boot('OpenAiController');
  const savedConversations = [];
  const conversations = {
    record: async (_org, conversationId, turns, _completion, intent) => {
      savedConversations.push({ conversationId, turns, intent });
      return conversationId ?? 'conv-new';
    },
  };
  const controller = new OpenAiController(renderer, conversations);
  const principal = { organizationId: 'org-1' };

  const res1 = fakeRes();
  await controller.chatCompletions(principal, { model: 'napoleon-1', messages: [{ role: 'user', content: 'How are we doing?' }] }, res1);
  check('a plain request answers with JSON', res1.state.body?.object === 'chat.completion');
  check('the conversation id is appended to the payload', res1.state.body?.napoleon_conversation_id === 'conv-new');
  check('the exchange is persisted', savedConversations.length === 1);
  check('the resolved intent is persisted', savedConversations[0].intent === 'overview');

  const res2 = fakeRes();
  await controller.chatCompletions(principal, { model: 'napoleon-risk', messages: [{ role: 'user', content: 'sites?' }], stream: true }, res2);
  check('streaming sets an SSE content type', String(res2.state.headers['Content-Type']).includes('text/event-stream'));
  check('streaming disables caching proxies', res2.state.headers['X-Accel-Buffering'] === 'no');
  check('streaming writes frames', res2.state.frames.length > 2);
  check('streaming ends the response', res2.state.ended === true);
  check('streaming does not also send JSON', res2.state.body === undefined);

  const res3 = fakeRes();
  await controller.chatCompletions(
    principal,
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an analyst.' },
        { role: 'user', content: [{ type: 'text', text: 'rank our sites' }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'which site worries you most?' },
      ],
    },
    res3,
  );
  check('multimodal content parts are flattened', res3.state.body?.choices[0].message.napoleon.intent === 'risk_by_site');
  check('the last user turn drives routing', res3.state.body?.model === 'gpt-4o');

  check('an unknown field is ignored', (await attempt(controller.chatCompletions(principal, { model: 'napoleon-1', messages: [{ role: 'user', content: 'hi' }], temperature: 0.9, top_p: 0.5, tools: [] }, fakeRes()))).ok === true);

  boot('error envelopes');
  const noMessages = await attempt(controller.chatCompletions(principal, { model: 'napoleon-1' }, fakeRes()));
  check('missing messages is a 400', noMessages.status === 400, noMessages.status);
  check('the error uses the OpenAI envelope', typeof noMessages.response?.error?.message === 'string');
  check('the error names the offending parameter', noMessages.response?.error?.param === 'messages');

  const badRole = await attempt(controller.chatCompletions(principal, { messages: [{ role: '', content: 'x' }] }, fakeRes()));
  check('an empty role is rejected', badRole.status === 400);
  check('the error path includes the index', badRole.response?.error?.param === 'messages[0].role');

  const badContent = await attempt(controller.chatCompletions(principal, { messages: [{ role: 'user', content: 42 }] }, fakeRes()));
  check('non-string content is rejected', badContent.status === 400);

  const bigN = await attempt(controller.chatCompletions(principal, { messages: [{ role: 'user', content: 'x' }], n: 5 }, fakeRes()));
  check('n > 1 is rejected', bigN.status === 400, bigN.status);
  check('the n error names its parameter', bigN.response?.error?.param === 'n');

  boot('GET /models');
  const list = controller.models();
  check('models is available without a principal', list.object === 'list' && list.data.length > 0);

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
