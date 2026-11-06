#!/usr/bin/env node
/** Stateful guest-side research browser. The caller owns VM lifecycle. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ACTIONS = new Set(['goto', 'click', 'fill', 'press', 'select', 'wait', 'scroll']);
const MAX_INPUT_BYTES = 65536;

function integer(value, fallback, low, high) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('Numeric options must be finite numbers');
  return Math.max(low, Math.min(high, Math.trunc(value)));
}

export function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new Error('A nonempty HTTP(S) URL of at most 8192 characters is required');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  }
  if (parsed.href.length > 8192) throw new Error('The encoded HTTP(S) URL exceeds 8192 characters');
  return parsed.href;
}

function target(input, required = true) {
  const result = {};
  for (const key of ['selector', 'role', 'name']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'role' ? 60 : 1000)) {
        throw new Error(`${key} must be a nonempty bounded string`);
      }
      result[key] = input[key];
    }
  }
  if (result.selector && (result.role || result.name)) throw new Error('Use selector OR role/name for an action');
  if (result.name && !result.role) throw new Error('name requires role');
  if (required && !result.selector && !result.role) throw new Error('This action requires selector or role/name');
  return result;
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object');
  const session = input.session ?? 'research';
  if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(session)) {
    throw new Error('session must be a 1-48 character slug containing only letters, digits, underscores, or hyphens');
  }
  const request = {
    session,
    timeout_ms: integer(input.timeout_ms, 30000, 1000, 60000),
    max_chars: integer(input.max_chars, 12000, 500, 30000),
    actions: [],
  };
  if (input.url !== undefined) request.url = httpUrl(input.url);
  const actions = input.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 10) throw new Error('actions must be an array with at most 10 entries');
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action) || !ACTIONS.has(action.type)) {
      throw new Error('Unsupported browser action; use goto, click, fill, press, select, wait, or scroll');
    }
    const copy = { type: action.type, timeout_ms: integer(action.timeout_ms, 10000, 250, 15000) };
    if (action.type === 'goto') copy.url = httpUrl(action.url);
    if (['click', 'fill', 'press', 'select'].includes(action.type)) Object.assign(copy, target(action));
    if (['wait', 'scroll'].includes(action.type)) Object.assign(copy, target(action, false));
    if (['fill', 'press', 'select'].includes(action.type)) {
      if (typeof action.value !== 'string' || action.value.length > (action.type === 'fill' ? 8192 : 500)) {
        throw new Error(`${action.type} requires a bounded string value`);
      }
      copy.value = action.value;
    }
    if (action.type === 'wait') copy.ms = integer(action.ms, 500, 0, 5000);
    if (action.type === 'scroll') {
      copy.x = integer(action.x, 0, -3000, 3000);
      copy.y = integer(action.y, 800, -3000, 3000);
    }
    request.actions.push(copy);
  }
  return request;
}

export const validateBrowserRequest = validateRequest;

export function resolveProfile(session, environment = process.env) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(session)) throw new Error('Invalid browser session');
  const base = environment.OVM_BROWSER_PROFILE || path.join(os.homedir(), '.local/share/ovm/research-browser');
  return path.join(path.resolve(base), session);
}

export function locatorFor(page, action) {
  if (action.selector) return page.locator(action.selector);
  return page.getByRole(action.role, action.name ? { name: action.name, exact: true } : {});
}

/** Detect actual gates, not articles which merely discuss login or CAPTCHA. */
export function detectConditions(snapshot, httpStatus = null) {
  const conditions = [];
  const title = String(snapshot.title || '').trim();
  const text = String(snapshot.body_text || snapshot.page_content || '').trim();
  const shortPage = text.length < 6000;
  const add = (type, message) => conditions.push({ type, message, requires_user: true });
  if (httpStatus === 429) add('rate_limited', 'The site returned HTTP 429. Retry later or use another source.');
  else if (httpStatus === 401) add('login_required', 'The site returned HTTP 401 and requires authentication.');
  else if (httpStatus === 403 || /^access denied(?:\b|$)/i.test(title)
           || shortPage && /^(?:access denied|permission denied|you (?:do not|don.t) have permission to access)/i.test(text)) {
    add('access_denied', 'The site denied access to this browser session.');
  }
  const challengeTitle = /^(?:just a moment|attention required|verify (?:you|your)|checking (?:your )?browser|security (?:check|verification)|captcha)(?:\b|[.!])/i.test(title);
  const challengeText = /(?:verify (?:that )?you are (?:a )?human|complete the security check|checking your browser before accessing|please solve (?:the )?captcha)/i.test(text);
  if (snapshot.challenge_modal || (snapshot.challenge_widget && shortPage) || (shortPage && challengeTitle && (challengeText || snapshot.challenge_widget))
      || (text.length < 1500 && challengeText && !snapshot.has_article)) {
    add('captcha', 'A visible human-verification challenge is blocking the page. Human handoff is required; the worker does not solve challenges.');
  }
  const loginTitle = /^(?:log ?in|sign[ -]?in|authentication required)(?:\s+to\b|\s*$|\s*[|:—–-])/i.test(title);
  if (!conditions.some(c => c.type === 'login_required')
      && (snapshot.login_modal || (snapshot.password_input && shortPage) || loginTitle && snapshot.login_form && shortPage)) {
    add('login_required', 'A login or credential form is blocking access. Continue through a human-controlled session if access is authorized.');
  }
  return conditions;
}

/** This fixed DOM reader never evaluates JavaScript supplied in tool input. */
export async function readSnapshot(page, maxChars) {
  return page.evaluate(({ maxChars }) => {
    const short = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visible = element => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
    };
    const webUrl = value => {
      try {
        const url = new URL(value, location.href);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url.href : null;
      } catch { return null; }
    };
    const bodyText = document.body?.innerText || '';
    const candidates = [...document.querySelectorAll('main,article,[role="main"]')]
      .filter(visible).map(element => element.innerText || '').filter(text => text.length > 100);
    const content = candidates.sort((a, b) => b.length - a.length)[0] || bodyText;
    const links = [];
    const seenLinks = new Set();
    for (const element of [...document.querySelectorAll('a[href]')].slice(0, 1000)) {
      const url = webUrl(element.href);
      const title = short(element.innerText || element.getAttribute('aria-label'), 160);
      if (url && title && visible(element) && !seenLinks.has(url)) {
        links.push({ title, url }); seenLinks.add(url);
      }
      if (links.length >= 40) break;
    }
    const selectorFor = element => {
      if (element.id) {
        const selector = '#' + CSS.escape(element.id);
        if (selector.length <= 1000 && document.querySelectorAll(selector).length === 1) return selector;
      }
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.parentElement) {
          const siblings = [...node.parentElement.children].filter(other => other.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        const selector = parts.join(' > ');
        if (document.querySelectorAll(selector).length === 1) return selector;
        node = node.parentElement;
      }
      return null;
    };
    const controls = [];
    for (const element of [...document.querySelectorAll('button,input:not([type="hidden"]),textarea,select,a[href],[role="button"],[role="textbox"],[role="checkbox"]')].slice(0, 500)) {
      if (!visible(element)) continue;
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute('type') || '';
      const roles = { button: 'button', textarea: 'textbox', select: 'combobox', a: 'link' };
      const inputRole = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', search: 'searchbox' };
      const role = element.getAttribute('role') || roles[tag] || (tag === 'input' ? inputRole[type] || 'textbox' : '');
      const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.innerText || '').join(' ');
      const labels = [...(element.labels || [])].map(label => label.innerText).join(' ');
      const name = short(element.getAttribute('aria-label') || labelledBy || labels || element.getAttribute('placeholder')
        || (tag === 'input' && ['submit', 'button'].includes(type) ? element.getAttribute('value') : element.innerText), 180);
      controls.push({ selector: selectorFor(element), role: short(role, 60), name,
        tag, type: short(type, 40), disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        ...(tag === 'select' ? { options: [...element.options].slice(0, 20).map(option => ({ value: short(option.value, 160), label: short(option.text, 160) })) } : {}),
      });
      if (controls.length >= 50) break;
    }
    const visibleNodes = selector => [...document.querySelectorAll(selector)].filter(visible);
    const visibleMatch = selector => visibleNodes(selector).length > 0;
    const inVisibleModal = element => {
      const modal = element.closest('[aria-modal="true"],[role="dialog"]');
      return Boolean(modal && visible(modal));
    };
    const challengeSelector = 'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile,#challenge-running,#challenge-stage';
    return {
      url: location.href,
      title: short(document.title, 300),
      page_content: content.slice(0, maxChars),
      body_text: bodyText.slice(0, 7000),
      links, controls,
      truncated: content.length > maxChars,
      available_chars: content.length,
      has_article: candidates.length > 0,
      password_input: visibleMatch('input[type="password"]'),
      login_form: visibleMatch('form,input[type="password"],input[type="email"],button'),
      login_modal: visibleNodes('input[type="password"]').some(inVisibleModal),
      challenge_widget: visibleMatch(challengeSelector),
      challenge_modal: visibleNodes(challengeSelector).some(inVisibleModal),
    };
  }, { maxChars });
}

async function loadPlaywright(environment) {
  const requested = environment.PLAYWRIGHT_MODULE;
  try {
    const module = await import(requested ? (path.isAbsolute(requested) ? pathToFileURL(requested).href : requested) : 'playwright');
    const chromium = module.chromium || module.default?.chromium;
    if (!chromium?.launchPersistentContext) throw new Error('Module does not export Chromium');
    return chromium;
  } catch (error) {
    throw new Error('Playwright is unavailable in the guest. Install playwright and Chromium or set PLAYWRIGHT_MODULE: ' + error.message.slice(0, 300));
  }
}

function errorText(error) { return String(error?.message || error).slice(0, 700); }

/** Keep the transport bound in bytes, including multilingual DOM metadata. */
export function boundResult(result, maximumBytes = 256 * 1024) {
  maximumBytes = integer(maximumBytes, 256 * 1024, 1024, 256 * 1024);
  const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size(result) <= maximumBytes) return result;
  const bounded = structuredClone(result);
  bounded.metadata = { ...bounded.metadata, output_truncated: true };
  for (const field of ['url', 'final_url']) {
    if (typeof bounded[field] === 'string' && Buffer.byteLength(bounded[field], 'utf8') > 16384) {
      // Never emit a chopped URL as if it were a real source address.
      bounded[field] = null;
      bounded.metadata.provenance_omitted = true;
    }
  }
  for (const [key, value] of Object.entries(bounded.metadata)) {
    if (typeof value === 'string') bounded.metadata[key] = value.slice(0, 1000);
  }
  bounded.links = (bounded.links || []).filter(link => String(link.url || '').length <= 2048).slice(0, 20);
  bounded.controls = (bounded.controls || []).slice(0, 30).map(control => ({ ...control,
    ...(control.options ? { options: control.options.slice(0, 10) } : {}) }));
  // Preserve the primary text and completed action statuses before extra controls.
  for (const field of ['links', 'controls']) {
    while (bounded[field].length && size(bounded) > maximumBytes) {
      bounded[field] = bounded[field].slice(0, Math.floor(bounded[field].length / 2));
    }
  }
  if (size(bounded) > maximumBytes) {
    bounded.actions = (bounded.actions || []).map(action => ({ index: action.index, type: action.type,
      status: action.status, ...(action.error ? { error: String(action.error).slice(0, 300) } : {}) }));
  }
  if (size(bounded) > maximumBytes) {
    const text = String(bounded.page_content || '');
    bounded.truncated = true;
    let low = 0, high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      bounded.page_content = text.slice(0, mid);
      if (size(bounded) <= maximumBytes) low = mid; else high = mid - 1;
    }
    bounded.page_content = text.slice(0, low);
  }
  if (size(bounded) > maximumBytes) {
    // Defensive last boundary for unexpected nested browser metadata. The
    // action verdict stays intact even when the transport must omit details.
    const status = ['ok', 'partial', 'blocked', 'error'].includes(result.status) ? result.status : 'error';
    const minimal = { status, url: null, final_url: null, title: String(result.title || '').slice(0, 300),
      page_content: String(result.page_content || '').slice(0, Math.floor(maximumBytes / 16)), links: [], controls: [],
      conditions: [], actions: (result.actions || []).slice(0, 10).map(action => ({
        index: action.index, type: String(action.type || '').slice(0, 20), status: String(action.status || '').slice(0, 20),
      })), metadata: { rendered: Boolean(result.metadata?.rendered), output_truncated: true, provenance_omitted: true }, truncated: true };
    if (size(minimal) > maximumBytes) { minimal.page_content = ''; minimal.title = ''; minimal.actions = []; }
    return minimal;
  }
  return bounded;
}

export async function runResearchBrowser(input, dependencies = {}) {
  let request;
  try { request = validateRequest(input); }
  catch (error) {
    return { status: 'error', url: null, final_url: null, title: '', page_content: '', links: [], controls: [],
      conditions: [], actions: [], metadata: { rendered: false }, error: errorText(error) };
  }
  const environment = dependencies.environment || process.env;
  const profile = resolveProfile(request.session, environment);
  const started = Date.now();
  const deadline = started + request.timeout_ms;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('Browser time budget exhausted');
    return value;
  };
  const output = { status: 'error', url: request.url || null, final_url: null, title: '', page_content: '', links: [], controls: [],
    conditions: [], actions: [], truncated: false, metadata: { rendered: false, session: request.session, persistent_profile: true,
      http_status: null, content_type: null, requested_timeout_ms: request.timeout_ms } };
  let context, page, timer;
  let httpStatus = null, contentType = null;
  let timedOut = false;
  const statePath = path.join(profile, '.session.json');

  const settle = async () => {
    // Long polling and analytics should not hold research hostage. The bounded
    // network-idle attempt also gives ordinary delayed JavaScript time to render.
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(1800, remaining()) }); }
    catch { /* a live page can remain network-active */ }
    await page.waitForTimeout(Math.min(200, remaining()));
    try {
      await page.waitForFunction(() => {
        const roots = [...document.querySelectorAll('main,article,[role="main"]')];
        const text = (roots.length ? roots.map(element => element.innerText || '').join('\n') : document.body?.innerText || '').trim();
        return text.length >= 40 && !/^(?:loading|please wait|initializing|connecting)[.\s!…]*$/i.test(text);
      }, null, { timeout: Math.min(3000, remaining()) });
    } catch { /* thin documents remain usable after this bounded rendering wait */ }
  };
  const snapshot = async () => {
    const data = await readSnapshot(page, request.max_chars);
    output.final_url = data.url;
    output.title = data.title;
    output.page_content = data.page_content;
    output.links = data.links;
    output.controls = data.controls;
    output.truncated = data.truncated;
    output.conditions = detectConditions(data, httpStatus);
    Object.assign(output.metadata, { rendered: true, http_status: httpStatus, content_type: contentType,
      truncated: data.truncated, available_chars: data.available_chars });
    return data;
  };
  const navigate = async url => {
    httpStatus = null; contentType = null;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
    await settle();
  };
  const workflow = async () => {
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    const chromium = dependencies.chromium || await loadPlaywright(environment);
    const launch = { headless: true, timeout: remaining(), viewport: { width: 1280, height: 900 }, acceptDownloads: false };
    if (environment.OVM_BROWSER_EXECUTABLE) launch.executablePath = environment.OVM_BROWSER_EXECUTABLE;
    if (environment.OVM_BROWSER_NO_SANDBOX === '1') launch.args = ['--no-sandbox'];
    if (environment.OVM_BROWSER_PROXY) launch.proxy = { server: environment.OVM_BROWSER_PROXY, bypass: '<-loopback>' };
    context = await chromium.launchPersistentContext(profile, launch);
    if (timedOut) {
      await context.close();
      throw new Error('Browser time budget exhausted during launch');
    }
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(Math.min(10000, remaining()));
    page.on('response', response => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          httpStatus = response.status(); contentType = String(response.headers()['content-type'] || '').slice(0, 300) || null;
        }
      } catch { /* navigation may replace a frame while events are delivered */ }
    });
    let initial = request.url;
    if (!initial && request.actions[0]?.type !== 'goto') {
      try {
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (state.last_url) initial = httpUrl(state.last_url);
      } catch { /* a new session has no last URL */ }
    }
    if (!initial && !request.actions.some(action => action.type === 'goto')) {
      throw new Error('This session has no saved page. Supply url or a goto action.');
    }
    if (initial) {
      output.url ||= initial;
      await navigate(initial);
      await snapshot();
    }
    for (let index = 0; index < request.actions.length; index++) {
      const action = request.actions[index];
      // A gate restricts interactions with that page, not navigation to a
      // different public source. Never trap a persisted session on a login page.
      if (action.type !== 'goto' && output.conditions.some(condition => condition.requires_user)) {
        output.metadata.actions_skipped = request.actions.length - index;
        break;
      }
      const record = { index, type: action.type, status: 'pending' };
      if (action.selector) record.selector = action.selector;
      if (action.role) Object.assign(record, { role: action.role, name: action.name });
      if (action.type === 'goto') record.url = action.url;
      // Form values (including accidental credentials) never enter action logs.
      if (action.value !== undefined) record.value_length = action.value.length;
      output.actions.push(record);
      try {
        const timeout = Math.min(action.timeout_ms, remaining());
        if (action.type === 'goto') {
          output.url ||= action.url;
          await navigate(action.url);
        }
        else if (action.type === 'click') await locatorFor(page, action).click({ timeout });
        else if (action.type === 'fill') await locatorFor(page, action).fill(action.value, { timeout });
        else if (action.type === 'press') await locatorFor(page, action).press(action.value, { timeout });
        else if (action.type === 'select') await locatorFor(page, action).selectOption(action.value, { timeout });
        else if (action.type === 'wait') {
          if (action.selector || action.role) await locatorFor(page, action).waitFor({ state: 'visible', timeout });
          else await page.waitForTimeout(Math.min(action.ms, remaining()));
        } else if (action.type === 'scroll') {
          if (action.selector || action.role) await locatorFor(page, action).scrollIntoViewIfNeeded({ timeout });
          else await page.mouse.wheel(action.x, action.y);
        }
        if (!['goto', 'fill', 'wait'].includes(action.type)) await settle();
        record.status = 'ok';
        await snapshot();
      } catch (error) {
        let message = errorText(error);
        if (action.value) message = message.replaceAll(action.value, '[redacted value]');
        record.status = 'error'; record.error = message;
        output.error = `Action ${index + 1} (${action.type}) failed: ${message}`;
        output.metadata.actions_skipped = request.actions.length - index - 1;
        // Only associate returned evidence with the DOM/URL read together here.
        await snapshot();
        break;
      }
    }
    if (!output.metadata.rendered) await snapshot();
    output.status = output.conditions.some(condition => condition.requires_user) ? 'blocked'
      : output.error ? (output.page_content ? 'partial' : 'error')
        : output.page_content ? 'ok' : 'partial';
    if (!output.page_content && !output.error) output.error = 'The rendered page contains no visible text. Inspect returned controls or supply a wait/action.';
    const currentUrl = page.url();
    if (currentUrl.startsWith('http://') || currentUrl.startsWith('https://')) {
      const temporary = statePath + `.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ last_url: currentUrl, updated_at: new Date().toISOString() }), { mode: 0o600 });
      await fs.rename(temporary, statePath);
    }
    return output;
  };
  try {
    await Promise.race([
      workflow(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('Browser time budget exhausted')); }, request.timeout_ms); }),
    ]);
  } catch (error) {
    output.error = errorText(error);
    if (timedOut) {
      // A prior snapshot may describe a different document from an unfinished
      // action. Do not return it as if it came from the final URL.
      output.page_content = ''; output.links = []; output.controls = [];
      output.status = 'error'; output.metadata.timed_out = true;
    } else {
      output.status = output.conditions.some(condition => condition.requires_user) ? 'blocked'
        : output.page_content ? 'partial' : 'error';
    }
    if (/SingletonLock|ProcessSingleton|user data directory is already in use/i.test(output.error)) {
      output.error = 'This browser session is already in use. Retry after the other call completes or choose another session slug.';
    }
  } finally {
    clearTimeout(timer);
    if (context) {
      try { await context.close(); }
      catch (error) { output.metadata.close_error = errorText(error); }
    }
    output.metadata.elapsed_ms = Date.now() - started;
  }
  return boundResult(output);
}

export async function main() {
  let bytes = 0;
  const parts = [];
  try {
    for await (const part of process.stdin) {
      bytes += part.length;
      if (bytes > MAX_INPUT_BYTES) throw new Error('Browser request exceeds 64 KiB');
      parts.push(part);
    }
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const result = await runResearchBrowser(input);
    process.stdout.write(JSON.stringify(boundResult(result)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'error', url: null, final_url: null, title: '', page_content: '',
      links: [], controls: [], conditions: [], actions: [], metadata: { rendered: false }, error: errorText(error) }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
