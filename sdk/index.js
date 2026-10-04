'use strict';

/**
 * Napoleon API client.
 *
 * Zero dependencies — uses the global `fetch` (Node 18+, browsers, Deno, Bun).
 * CommonJS so it can be required or imported from anywhere.
 *
 *   const { NapoleonClient } = require('napoleon-client');
 *   const napoleon = new NapoleonClient({
 *     baseUrl: 'https://your-host/api/v1',
 *     apiKey: process.env.NAPOLEON_KEY,   // sk_napoleon_…
 *   });
 *
 *   await napoleon.ingest.sites([{ externalId: 'riverside', name: 'Riverside' }]);
 *   const health = await napoleon.insights.overview();
 *
 * `baseUrl` is the API root, not the chat path — the OpenAI-compatible endpoint
 * lives at the root of this API (`/chat/completions`), so an OpenAI client points
 * at the same baseUrl.
 */

class NapoleonError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'NapoleonError';
    this.status = status;
    this.body = body;
  }
}

// ── Namespaces ──────────────────────────────────────────────────────────────

class ChatCompletions {
  constructor(client) {
    this._client = client;
  }

  /**
   * Mirrors `openai.chat.completions.create`.
   *
   * @param {object} params
   * @param {string} [params.model='napoleon-1']  napoleon-1 | napoleon-risk |
   *   napoleon-guards, or any OpenAI model name — routing then falls back to
   *   reading the prompt.
   * @param {Array<{role:string, content:string|object[]}>} params.messages
   * @param {boolean} [params.stream=false]  when true, resolves to an async
   *   iterator of chat.completion.chunk objects
   * @param {string} [params.conversation_id]
   */
  create(params = {}) {
    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      return Promise.reject(
        new NapoleonError('`messages` must be a non-empty array', 0, null),
      );
    }
    if (params.n !== undefined && Number(params.n) > 1) {
      return Promise.reject(
        new NapoleonError('`n` greater than 1 is not supported', 0, null),
      );
    }

    const body = {
      model: params.model || 'napoleon-1',
      messages: params.messages,
      stream: params.stream === true,
      ...(params.conversation_id
        ? { conversation_id: params.conversation_id }
        : {}),
    };

    if (body.stream) return this._client._stream('/chat/completions', body);
    return this._client._request('POST', '/chat/completions', body);
  }
}

class Models {
  constructor(client) {
    this._client = client;
  }

  /** Public — no API key needed. */
  list() {
    return this._client._request('GET', '/models');
  }
}

class Insights {
  constructor(client) {
    this._client = client;
  }

  /** Health score, KPIs and rule-based insights. */
  overview() {
    return this._client._request('GET', '/insights/overview');
  }

  /** Sites ranked by risk over 30 days, most exposed first. */
  riskBySite() {
    return this._client._request('GET', '/insights/risk-by-site');
  }

  /** Personnel flagged over 14 days, with the reasons. */
  atRiskGuards() {
    return this._client._request('GET', '/insights/at-risk-guards');
  }
}

class Metrics {
  constructor(client) {
    this._client = client;
  }

  /**
   * Incident totals, a daily series and a breakdown by type.
   * @param {{days?:number, type?:string, from?:string, to?:string}} [query]
   */
  incidents(query = {}) {
    const qs = new URLSearchParams();
    for (const key of ['days', 'type', 'from', 'to']) {
      if (query[key] !== undefined && query[key] !== null) {
        qs.set(key, String(query[key]));
      }
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this._client._request('GET', `/metrics/incidents${suffix}`);
  }
}

class Analyze {
  constructor(client) {
    this._client = client;
  }

  /**
   * Is this value unusual for this history? Stateless — nothing is stored, so
   * no ingestion is required for this endpoint.
   *
   * @param {{metric:string, value:number, history:number[], entityId?:string,
   *          date?:string, prior?:{mean:number,stdDev:number}}} input
   */
  score(input) {
    return this._client._request('POST', '/analyze', input);
  }

  /** Score many values in one round trip. Items are scored independently. */
  batch(items) {
    return this._client._request('POST', '/analyze/batch', { items });
  }
}

class Keys {
  constructor(client) {
    this._client = client;
  }

  /** Requires an ADMIN key. The plaintext is returned once. */
  create({ name, scope }) {
    return this._client._request('POST', '/keys', {
      name,
      ...(scope ? { scope } : {}),
    });
  }

  list() {
    return this._client._request('GET', '/keys');
  }

  revoke(id) {
    return this._client._request('DELETE', `/keys/${encodeURIComponent(id)}`);
  }
}

class Ingest {
  constructor(client) {
    this._client = client;
  }

  /**
   * Every record carries your own `externalId`; upserts key on
   * (organization, externalId), so re-sending a batch is always safe.
   * Requires an ADMIN key.
   *
   * Load order on a first run: sites -> guards -> incidents/attendance ->
   * patrols.
   */
  sites(sites) {
    return this._client._request('POST', '/ingest/sites', { sites });
  }

  guards(guards) {
    return this._client._request('POST', '/ingest/guards', { guards });
  }

  incidents(incidents) {
    return this._client._request('POST', '/ingest/incidents', { incidents });
  }

  attendance(attendance) {
    return this._client._request('POST', '/ingest/attendance', { attendance });
  }

  /** Routes must exist (or be created here) before their records. */
  patrols({ routes = [], records = [] } = {}) {
    return this._client._request('POST', '/ingest/patrols', { routes, records });
  }

  /** Erases every operational record. API keys and the organization survive. */
  eraseData() {
    return this._client._request('DELETE', '/ingest/data?confirm=erase-all');
  }
}

class Conversations {
  constructor(client) {
    this._client = client;
  }

  list(limit) {
    const suffix = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return this._client._request('GET', `/conversations${suffix}`);
  }

  get(id) {
    return this._client._request(
      'GET',
      `/conversations/${encodeURIComponent(id)}`,
    );
  }

  remove(id) {
    return this._client._request(
      'DELETE',
      `/conversations/${encodeURIComponent(id)}`,
    );
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

class NapoleonClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  API root, e.g. https://host/api/v1
   * @param {string} [options.apiKey] an sk_napoleon_ key. Optional only for the
   *   public /models and /health routes.
   * @param {number} [options.timeoutMs=30000]
   * @param {typeof fetch} [options.fetch] override for tests / polyfills
   */
  constructor(options = {}) {
    if (!options.baseUrl) {
      throw new Error('NapoleonClient requires a baseUrl');
    }
    this.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs ?? 30000;
    this._fetch = options.fetch ?? globalThis.fetch;

    if (typeof this._fetch !== 'function') {
      throw new Error(
        'No fetch implementation available — pass options.fetch (Node < 18)',
      );
    }

    this.chat = { completions: new ChatCompletions(this) };
    this.models = new Models(this);
    this.insights = new Insights(this);
    this.metrics = new Metrics(this);
    this.analyze = new Analyze(this);
    this.keys = new Keys(this);
    this.ingest = new Ingest(this);
    this.conversations = new Conversations(this);
  }

  /** Liveness. Public. */
  health() {
    return this._request('GET', '/health');
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _headers(extra) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async _request(method, path, body) {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;

    let res;
    try {
      res = await this._fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this._headers({ Accept: 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw new NapoleonError(
        `Request to ${path} failed: ${err && err.message ? err.message : err}`,
        0,
        null,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = await res.text();
    const parsed = this._tryParse(text);

    if (!res.ok) {
      throw new NapoleonError(this._errorMessage(parsed, res.status), res.status, parsed);
    }
    return parsed;
  }

  async _stream(path, body) {
    const res = await this._fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new NapoleonError(
        this._errorMessage(this._tryParse(text), res.status),
        res.status,
        this._tryParse(text),
      );
    }

    return parseSse(res);
  }

  _tryParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Handles both the OpenAI error envelope and Nest's default body. */
  _errorMessage(parsed, status) {
    if (parsed && parsed.error && parsed.error.message) {
      return parsed.error.message;
    }
    if (parsed && parsed.message) {
      const m = parsed.message;
      return Array.isArray(m) ? m.join(', ') : String(m);
    }
    return `HTTP ${status}`;
  }
}

/** Decode an SSE response body into an async iterator of chunk objects. */
async function* parseSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // Ignore malformed keep-alive frames rather than killing the stream.
      }
    }
  }
}

module.exports = { NapoleonClient, NapoleonError, parseSse };
