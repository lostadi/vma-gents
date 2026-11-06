import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { boundResult, detectConditions, httpUrl, locatorFor, resolveProfile, runResearchBrowser, validateRequest } from '../guest/research-browser.mjs';

test('requests bound actions, values, deadlines, and profile slugs', () => {
  const result = validateRequest({ url: 'https://example.org', timeout_ms: 999999, max_chars: 999999,
    actions: [{ type: 'scroll', y: 999999 }, { type: 'wait', ms: 99999 }] });
  assert.equal(result.timeout_ms, 60000);
  assert.equal(result.max_chars, 30000);
  assert.equal(result.actions[0].y, 3000);
  assert.equal(result.actions[1].ms, 5000);
  assert.throws(() => validateRequest({ session: '../outside' }), /slug/);
  assert.throws(() => validateRequest({ actions: Array.from({ length: 11 }, () => ({ type: 'wait' })) }), /10/);
  assert.throws(() => validateRequest({ actions: [{ type: 'evaluate', value: 'process.exit()' }] }), /Unsupported/);
  assert.throws(() => validateRequest({ actions: [{ type: 'fill', selector: '#q', role: 'textbox', value: 'test' }] }), /selector OR/);
  assert.throws(() => validateRequest({ timeout_ms: 'forever' }), /finite/);
});

test('navigation accepts HTTP(S), rejects credentials and executable schemes', () => {
  assert.equal(httpUrl('https://example.org/path?q=test'), 'https://example.org/path?q=test');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://u:p@example.org', '/relative']) {
    assert.throws(() => httpUrl(url));
  }
});

test('profile path uses trusted environment and validated session only', () => {
  assert.equal(resolveProfile('research_2', { OVM_BROWSER_PROFILE: '/guest/profiles' }), '/guest/profiles/research_2');
  assert.throws(() => resolveProfile('../../escape', { OVM_BROWSER_PROFILE: '/guest/profiles' }));
  const request = validateRequest({ session: 'valid', userDataDir: '/untrusted', executablePath: '/untrusted' });
  assert.equal(request.userDataDir, undefined);
  assert.equal(request.executablePath, undefined);
});

test('conditions detect actual gates without blocking research about CAPTCHA', () => {
  const article = { title: 'How CAPTCHA protects login forms', body_text: 'An article explains: verify you are human. ' + 'Research evidence. '.repeat(500), has_article: true };
  assert.deepEqual(detectConditions(article, 200), []);
  assert.equal(detectConditions({ title: 'Just a moment...', body_text: 'Verify you are human', challenge_widget: true }, 200)[0].type, 'captcha');
  assert.equal(detectConditions({ title: 'Sign in', body_text: 'Email Password', password_input: true }, 200)[0].type, 'login_required');
  assert.equal(detectConditions({ title: 'Forbidden', body_text: 'Forbidden' }, 403)[0].type, 'access_denied');
  assert.equal(detectConditions({ title: 'Wait', body_text: 'Try later' }, 429)[0].type, 'rate_limited');
  assert.equal(detectConditions({ title: 'Login form tutorial', body_text: 'Code examples', password_input: false }, 200).length, 0);
  assert.equal(detectConditions({ ...article, challenge_widget: true, challenge_modal: true }, 200)[0].type, 'captcha');
  assert.equal(detectConditions({ ...article, password_input: true, login_modal: true }, 200)[0].type, 'login_required');
  assert.deepEqual(detectConditions({ ...article, challenge_widget: true, challenge_modal: false }, 200), []);
});

test('locator actions use CSS or an exact accessible role/name', () => {
  const page = { locator: selector => ({ selector }), getByRole: (role, options) => ({ role, options }) };
  assert.deepEqual(locatorFor(page, { selector: '#search' }), { selector: '#search' });
  assert.deepEqual(locatorFor(page, { role: 'button', name: 'Search' }), { role: 'button', options: { name: 'Search', exact: true } });
});

test('serialized multilingual metadata stays within 256 KiB without changing completed status', () => {
  const result = { status: 'ok', url: 'https://example.org', final_url: 'https://example.org', title: '日本語'.repeat(100),
    page_content: '文'.repeat(30000), conditions: [], actions: [{ index: 0, type: 'click', status: 'ok' }],
    metadata: { rendered: true }, links: Array.from({ length: 40 }, (_, i) => ({ url: 'https://example.org/' + i + 'x'.repeat(4000), title: '文'.repeat(160) })),
    controls: Array.from({ length: 50 }, () => ({ selector: '#field', name: '文'.repeat(180), options: Array.from({ length: 20 }, () => ({ value: '文'.repeat(160), label: '文'.repeat(160) })) })) };
  const bounded = boundResult(result);
  assert(Buffer.byteLength(JSON.stringify(bounded)) <= 256 * 1024);
  assert.equal(bounded.status, 'ok');
  assert.equal(bounded.metadata.output_truncated, true);
  assert.equal(bounded.page_content, result.page_content);
  assert.equal(bounded.actions[0].status, 'ok');
});

test('pathological redirect URL and nested metadata cannot exceed the byte boundary', () => {
  const result = { status: 'ok', url: 'https://example.org', final_url: 'https://example.org/' + 'x'.repeat(400000),
    title: 'A real page', page_content: 'Actual evidence', links: [], controls: [], conditions: [],
    actions: [{ index: 0, type: 'click', status: 'ok' }], metadata: { rendered: true, content_type: 'x'.repeat(400000) } };
  const capped = boundResult(result);
  assert(Buffer.byteLength(JSON.stringify(capped)) <= 256 * 1024);
  assert.equal(capped.status, 'ok');
  assert.equal(capped.final_url, null);
  assert.equal(capped.metadata.provenance_omitted, true);
  const unexpected = boundResult({ ...result, metadata: { rendered: true, nested: { huge: 'x'.repeat(500000) } } });
  assert(Buffer.byteLength(JSON.stringify(unexpected)) <= 256 * 1024);
  assert.equal(unexpected.status, 'ok');
  assert.equal(unexpected.metadata.output_truncated, true);
});

function fakeBrowser({ snapshot = {}, failClick = false, failFill = false } = {}) {
  const events = [];
  let currentUrl = 'about:blank';
  const page = {
    setDefaultTimeout() {}, on() {}, mainFrame() {},
    async goto(url) { currentUrl = url; events.push(['goto', url]); },
    async waitForLoadState() {}, async waitForTimeout() {}, url: () => currentUrl,
    async evaluate(_fn, args) { return { url: currentUrl, title: 'Fixture', page_content: 'Rendered research text', body_text: 'Rendered research text',
      links: [], controls: [], available_chars: 22, truncated: false, ...(typeof snapshot === 'function' ? snapshot(currentUrl) : snapshot) }; },
    locator(selector) { return {
      async fill(value) { if (failFill) throw new Error(`locator.fill("${value}") failed`); events.push(['fill', selector, value]); },
      async click() { if (failClick) throw new Error('Target not available'); events.push(['click', selector]); },
      async press(value) { events.push(['press', value]); }, async selectOption(value) { events.push(['select', value]); },
      async waitFor() {}, async scrollIntoViewIfNeeded() {},
    }; },
    mouse: { async wheel(x, y) { events.push(['scroll', x, y]); } },
  };
  const context = { pages: () => [page], async close() { events.push(['closed']); } };
  return { chromium: { async launchPersistentContext(profile, options) { events.push(['launch', profile, options]); return context; } }, events };
}

test('trusted guest proxy covers loopback without relaxing TLS verification', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  try {
    const browser = fakeBrowser();
    const result = await runResearchBrowser({ url: 'https://example.org', proxy: 'http://untrusted.invalid' },
      { ...browser, environment: { OVM_BROWSER_PROFILE: directory, OVM_BROWSER_PROXY: 'http://127.0.0.1:18080' } });
    assert.equal(result.status, 'ok');
    const launch = browser.events.find(event => event[0] === 'launch')[2];
    assert.deepEqual(launch.proxy, { server: 'http://127.0.0.1:18080', bypass: '<-loopback>' });
    assert.equal(launch.ignoreHTTPSErrors, undefined);
    assert.equal((launch.args || []).some(argument => argument.includes('ignore-certificate')), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('session restores last URL, closes context, and never logs fill values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  try {
    const first = fakeBrowser();
    const environment = { OVM_BROWSER_PROFILE: directory };
    const result = await runResearchBrowser({ url: 'https://example.org/fixture', session: 'test', actions: [
      { type: 'fill', selector: '#q', value: 'private form value' }, { type: 'click', selector: '#submit' },
    ] }, { ...first, environment });
    assert.equal(result.status, 'ok');
    assert.equal(result.actions[0].value_length, 18);
    assert.equal(JSON.stringify(result).includes('private form value'), false);
    assert.equal(first.events.at(-1)[0], 'closed');
    const second = fakeBrowser();
    const restored = await runResearchBrowser({ session: 'test', actions: [{ type: 'wait', ms: 10 }] }, { ...second, environment });
    assert.equal(restored.final_url, 'https://example.org/fixture');
    assert(second.events.some(event => event[0] === 'goto' && event[1] === 'https://example.org/fixture'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('challenge stops requested actions and reports blocked handoff', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  try {
    const browser = fakeBrowser({ snapshot: { title: 'Just a moment', body_text: 'Verify you are human', challenge_widget: true } });
    const result = await runResearchBrowser({ url: 'https://example.org', actions: [{ type: 'click', selector: '.captcha' }] },
      { ...browser, environment: { OVM_BROWSER_PROFILE: directory } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.conditions[0].requires_user, true);
    assert.equal(result.actions.length, 0);
    assert.equal(result.metadata.actions_skipped, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed action reports partial evidence and skips following actions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  try {
    const browser = fakeBrowser({ failClick: true });
    const result = await runResearchBrowser({ url: 'https://example.org', actions: [
      { type: 'click', selector: '#missing' }, { type: 'fill', selector: '#q', value: 'must not run' },
    ] }, { ...browser, environment: { OVM_BROWSER_PROFILE: directory } });
    assert.equal(result.status, 'partial');
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].status, 'error');
    assert.equal(result.metadata.actions_skipped, 1);
    assert.equal(browser.events.some(event => event[0] === 'fill'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Playwright error details redact a supplied form value', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  try {
    const browser = fakeBrowser({ failFill: true });
    const result = await runResearchBrowser({ url: 'https://example.org', actions: [{ type: 'fill', selector: '#q', value: 'private form value' }] },
      { ...browser, environment: { OVM_BROWSER_PROFILE: directory } });
    assert.equal(result.status, 'partial');
    assert.equal(JSON.stringify(result.actions).includes('private form value'), false);
    assert.equal(result.error.includes('private form value'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('explicit goto can leave a saved gate or the currently gated page', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  const environment = { OVM_BROWSER_PROFILE: directory };
  const blocked = url => url.endsWith('/gate') ? { title: 'Sign in', body_text: 'Login required', password_input: true } : {};
  try {
    const browser = fakeBrowser({ snapshot: blocked });
    const gate = await runResearchBrowser({ url: 'https://example.org/gate' }, { ...browser, environment });
    assert.equal(gate.status, 'blocked');
    const resumed = fakeBrowser({ snapshot: blocked });
    const publicPage = await runResearchBrowser({ actions: [{ type: 'goto', url: 'https://example.org/public' }] }, { ...resumed, environment });
    assert.equal(publicPage.status, 'ok');
    assert.equal(publicPage.final_url, 'https://example.org/public');
    assert.equal(resumed.events.some(event => event[0] === 'goto' && event[1].endsWith('/gate')), false);
    const escaped = await runResearchBrowser({ url: 'https://example.org/gate', actions: [{ type: 'goto', url: 'https://example.org/public' }] },
      { ...fakeBrowser({ snapshot: blocked }), environment });
    assert.equal(escaped.status, 'ok');
    assert.equal(escaped.actions[0].status, 'ok');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('deadline returns an error without stale evidence and closes the context', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  try {
    let closed = false;
    const page = { setDefaultTimeout() {}, on() {}, async goto() {}, async waitForLoadState() {}, async waitForTimeout() {},
      evaluate: () => new Promise(() => {}), url: () => 'https://example.org' };
    const chromium = { async launchPersistentContext() { return { pages: () => [page], async close() { closed = true; } }; } };
    const result = await runResearchBrowser({ url: 'https://example.org', timeout_ms: 1000 },
      { chromium, environment: { OVM_BROWSER_PROFILE: directory } });
    assert.equal(result.status, 'error');
    assert.equal(result.metadata.timed_out, true);
    assert.equal(result.page_content, '');
    assert.equal(closed, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

/** Optional real Chromium fixture, enabled after the guest/browser is provisioned. */
export async function startBrowserFixture() {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: '/final?topic=' + encodeURIComponent(url.searchParams.get('topic') || '') });
      return response.end();
    }
    if (url.pathname === '/final') {
      return response.end(`<title>Final evidence</title><main>Research topic: ${escape(url.searchParams.get('topic'))}. Persistent cookie: ${request.headers.cookie?.includes('research_fixture=present') ? 'present' : 'missing'}.</main><a href="/start">Start again</a>`);
    }
    if (url.pathname === '/challenge') return response.end('<title>Just a moment</title><main id="challenge-stage">Verify you are human</main><button>Continue</button>');
    response.setHeader('Set-Cookie', 'research_fixture=present; Max-Age=3600; Path=/; SameSite=Lax');
    response.end('<title>Delayed fixture</title><main id="evidence">Loading</main><form action="/redirect"><label for="topic">Research topic</label><input id="topic" name="topic"><button type="submit">Search</button></form><script>setTimeout(()=>{document.getElementById("evidence").textContent="Delayed JavaScript research evidence is ready";document.getElementById("evidence").id="ready";},250)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`,
    async close() { await new Promise(resolve => server.close(resolve)); } };
}

test('real Chromium renders delayed JS, submits form, follows redirect, restores cookie and URL',
  { skip: process.env.OVM_BROWSER_TEST_INTEGRATION !== '1' }, async () => {
    const fixture = await startBrowserFixture();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovm-browser-integration-'));
    const environment = { ...process.env, OVM_BROWSER_PROFILE: directory };
    try {
      const rendered = await runResearchBrowser({ url: fixture.base + '/start', session: 'fixture' }, { environment });
      assert.equal(rendered.status, 'ok', rendered.error);
      assert.match(rendered.page_content, /Delayed JavaScript research evidence/);
      assert(rendered.controls.some(control => control.selector === '#topic'));
      const submitted = await runResearchBrowser({ session: 'fixture', actions: [
        { type: 'fill', selector: '#topic', value: 'persistent sessions' },
        { type: 'click', role: 'button', name: 'Search' },
      ] }, { environment });
      assert.equal(submitted.status, 'ok', submitted.error);
      assert.match(submitted.final_url, /\/final\?topic=persistent/);
      assert.match(submitted.page_content, /Persistent cookie: present/);
      const resumed = await runResearchBrowser({ session: 'fixture' }, { environment });
      assert.equal(resumed.final_url, submitted.final_url);
      assert.match(resumed.page_content, /Persistent cookie: present/);
      const blocked = await runResearchBrowser({ url: fixture.base + '/challenge', session: 'fixture',
        actions: [{ type: 'click', role: 'button', name: 'Continue' }] }, { environment });
      assert.equal(blocked.status, 'blocked');
      assert.equal(blocked.actions.length, 0);
    } finally {
      await fixture.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
