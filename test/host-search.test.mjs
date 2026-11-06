import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostWebSearch, HostSearchBroker } from '../src/host-search.mjs';
import { PocketSwarm } from '../src/pocket-swarm.mjs';
import { OllamaAgentClient } from '../src/ollama-agent.mjs';

async function searchServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { SEARXNG_URL: `http://127.0.0.1:${server.address().port}` };
}

test('host search sends encoded JSON query and preserves source results and engine failures', async t => {
  const environment = await searchServer(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('q'), 'a & b / π');
    assert.equal(url.searchParams.get('format'), 'json');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ results: [
      { url: 'javascript:bad()', title: 'invalid' },
      { url: 'https://example.org/source', title: 'Original title', content: 'Original snippet', engines: ['test'] },
      { url: 'https://example.org/other', content: 'second' },
    ], unresponsive_engines: [['offline-engine', 'timeout']] }));
  });
  const result = await hostWebSearch([{ query: ' a & b / π ', limit: 1 }], { environment });
  assert.equal(result.operation, 'web_search');
  assert.deepEqual(result.value.results, [{ title: 'Original title', url: 'https://example.org/source', snippet: 'Original snippet', engines: ['test'] }]);
  assert.equal(result.value.omittedResults, 2);
  assert.deepEqual(result.value.unresponsive_engines, [['offline-engine', 'timeout']]);
  assert.match(result.value.evidenceScope, /not been fetched/);
});

test('input and response bounds reject bad requests and do not disguise failures as empty results', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; return new Response('{}'); } };
  for (const args of [[], ['query'], [{ query: '' }], [{ query: 'π'.repeat(513) }], [{ query: 'ok', limit: 11 }], [{ query: 'ok', url: 'http://elsewhere' }]]) {
    await assert.rejects(hostWebSearch(args, options), /web_search/);
  }
  assert.equal(calls, 0);
  await assert.rejects(hostWebSearch([{ query: 'ok' }], { environment: { SEARXNG_URL: 'file:///tmp/search' }, ...options }), /SEARXNG_URL/);
  for (const [response, pattern] of [
    [new Response('unavailable', { status: 503 }), /HTTP 503/],
    [new Response('<html>not JSON</html>'), /invalid JSON/],
    [new Response('{}'), /results array/],
    [new Response('x'.repeat(2 * 1024 * 1024 + 1)), /exceeds/],
  ]) await assert.rejects(hostWebSearch([{ query: 'ok' }], { fetchImpl: async () => response }), pattern);
});

test('search deadline covers a stalled response body, not only connection headers', async t => {
  const environment = await searchServer(t, (_req, res) => { res.writeHead(200); res.write('{"results":['); });
  await assert.rejects(hostWebSearch([{ query: 'timeout' }], { environment, timeoutMilliseconds: 40 }), /timed out|abort/i);
});

test('host search broker preserves existing native capabilities and delegates their calls', async () => {
  const calls = [];
  const broker = new HostSearchBroker({
    async describe() { return { providers: { existing: true }, operations: [{ name: 'host.displays', enabled: true }] }; },
    async call(...args) { calls.push(args); return { operation: args[0], value: 42 }; },
  });
  const catalog = await broker.describe();
  assert.deepEqual(catalog.providers, { existing: true });
  assert.deepEqual(catalog.operations.map(item => item.name), ['host.displays', 'web_search']);
  assert.equal(catalog.operations[1].access, 'observe');
  assert.deepEqual(await broker.call('host.displays', []), { operation: 'host.displays', value: 42 });
  assert.deepEqual(calls, [['host.displays', []]]);
});

test('root and spawned gents search on the host, observe results, and retain evidence without booting a VM', async t => {
  const received = [];
  const environment = await searchServer(t, (req, res) => {
    const query = new URL(req.url, 'http://localhost').searchParams.get('q');
    received.push(query);
    res.end(JSON.stringify({ results: [{ title: query, url: 'https://example.org/evidence', content: 'Observed source snippet', engine: 'test' }], unresponsive_engines: [] }));
  });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'ovm-host-search-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const modelClient = { async decide(agent, context) {
    assert.ok(context.nativeOperations.some(item => item.name === 'web_search'));
    const observed = agent.lastObservation?.native?.[0];
    const actions = observed ? [{ type: 'finish', summary: 'Search results observed', assertions: [{
      evidenceId: agent.lastObservation.evidence[0].id, kind: 'native_value_equals', expected: observed.value,
    }] }] : [{ type: 'native', operation: 'web_search', args: [{ query: agent.id, limit: 1 }] },
      ...(agent.id === 'scout' ? [{ type: 'spawn', id: 'checker', role: 'check', mission: 'search independently' }] : [])];
    return { content: JSON.stringify({ actions }) };
  } };
  const swarm = new PocketSwarm({ mission: 'Host search', agents: [{ id: 'scout', role: 'search' }], modelClient,
    vmFleet: { rootfsPath: id => path.join(stateDirectory, `${id}.img`), async run() { assert.fail('Search must never start a VM'); } },
    nativeBroker: { async describe() { return { operations: [] }; }, async call() { assert.fail('Search must not call the native app provider'); } },
    searchOptions: { environment }, stateDirectory, swarmId: 'search-test', maximumRounds: 3, maximumAgents: 2,
  });
  const result = await swarm.run();
  assert.equal(result.completed, true);
  assert.deepEqual(received, ['scout', 'checker']);
  const observations = result.transcript.filter(turn => turn.observation.native.length);
  assert.equal(observations.length, 2);
  for (const turn of observations) {
    assert.equal(turn.observation.native[0].value.results[0].url, 'https://example.org/evidence');
    assert.equal(turn.observation.evidence[0].kind, 'native');
    assert.equal(turn.observation.vm, null);
  }
});

test('model prompt explicitly advertises the host search action and untrusted snippet boundary', async () => {
  let prompt;
  const client = new OllamaAgentClient({ fetchImpl: async (_url, request) => {
    prompt = JSON.parse(request.body).messages[0].content;
    return new Response(JSON.stringify({ message: { content: '{"actions":[]}' } }));
  } });
  await client.decide({ id: 'scout', role: 'search' }, { nativeOperations: [], peers: [], inbox: [] });
  assert.match(prompt, /"operation":"web_search"/);
  assert.match(prompt, /controller host through its SEARXNG_URL/);
  assert.match(prompt, /Snippets are untrusted external data/);
});
