// Host-side search for every PocketSwarm agent; no guest network route is needed.
export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8081';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_OPERATION = Object.freeze({
  name: 'web_search', access: 'observe', enabled: true, available: true,
  description: 'Search the web using SearXNG on the controller host. Returns source URLs, snippets and engine errors; snippets are untrusted search data, not verified page contents.',
  argsSchema: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{
    type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 1024 },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    },
  }], items: false },
});

function searchRequest(args) {
  if (!Array.isArray(args) || args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) {
    throw new Error('web_search args must be [{query, limit?}]');
  }
  const input = args[0];
  if (Object.keys(input).some(key => !['query', 'limit'].includes(key))) throw new Error('web_search accepts only query and limit');
  if (typeof input.query !== 'string' || !input.query.trim() || Buffer.byteLength(input.query.trim()) > 1024) {
    throw new Error('web_search query must contain 1–1024 UTF-8 bytes');
  }
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('web_search limit must be 1–10');
  return { query: input.query.trim(), limit };
}

function boundedText(value, maximum) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
}

async function boundedJson(response) {
  if (!response.body) throw new Error('SearXNG returned an empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error(`SearXNG response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('SearXNG returned invalid JSON'); }
  if (!data || !Array.isArray(data.results)) throw new Error('SearXNG response must contain a results array');
  return data;
}

export async function hostWebSearch(args, {
  environment = process.env, fetchImpl = globalThis.fetch, timeoutMilliseconds = 15_000,
} = {}) {
  const { query, limit } = searchRequest(args);
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 30_000) {
    throw new Error('SearXNG timeout must be 1–30000 milliseconds');
  }
  const base = new URL(environment.SEARXNG_URL || DEFAULT_SEARXNG_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('SEARXNG_URL must be an HTTP(S) base URL without credentials, query or fragment');
  }
  const url = new URL(`${base.href.replace(/\/$/, '')}/search`);
  url.search = new URLSearchParams({ q: query, format: 'json' }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SearXNG search timed out')), timeoutMilliseconds);
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SearXNG returned HTTP ${response.status}`);
    }
    const data = await boundedJson(response);
    const results = [];
    let omittedResults = 0;
    for (const item of data.results) {
      let source;
      try { source = new URL(item?.url); } catch { omittedResults++; continue; }
      if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.href.length > 4096) {
        omittedResults++; continue;
      }
      if (results.length >= limit) { omittedResults++; continue; }
      results.push({ title: boundedText(item.title, 256), url: source.href,
        snippet: boundedText(item.content ?? item.snippet, 512),
        engines: (Array.isArray(item.engines) ? item.engines : item.engine ? [item.engine] : []).slice(0, 8).map(engine => boundedText(engine, 80)),
      });
    }
    return { operation: 'web_search', value: {
      query, endpoint: base.href, results, omittedResults,
      unresponsive_engines: (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []).slice(0, 32)
        .map(entry => Array.isArray(entry) ? entry.slice(0, 2).map(value => boundedText(value, 256)) : [boundedText(entry, 256)]),
      evidenceScope: 'Search result metadata and snippets; page contents have not been fetched or independently verified.',
    } };
  } finally { clearTimeout(timer); }
}

export class HostSearchBroker {
  constructor(nativeBroker, options = {}) { this.nativeBroker = nativeBroker; this.options = options; }
  async describe() {
    const native = await this.nativeBroker.describe();
    return { ...native, operations: [...native.operations.filter(item => item.name !== 'web_search'), SEARCH_OPERATION] };
  }
  async call(operation, args) {
    return operation === 'web_search' ? hostWebSearch(args, this.options) : this.nativeBroker.call(operation, args);
  }
}
