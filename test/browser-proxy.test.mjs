import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { lstat } from 'node:fs/promises';
import { once } from 'node:events';
import { connectTarget, startBrowserProxy } from '../src/browser-proxy.mjs';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const request = (socketPath, url, { method = 'GET', body = '', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: url, method, headers }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', part => body += part);
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  req.on('error', reject); req.end(body);
});

test('CONNECT authorities are bounded and cannot carry URL or header syntax', () => {
  assert.deepEqual(connectTarget('example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(connectTarget('[::1]:8080'), { host: '::1', port: 8080 });
  for (const authority of ['example.com', 'example.com:0', 'example.com:99999', 'u:p@example.com:443', 'example.com:443/path', 'example.com:443\r\nx: y']) assert.throws(() => connectTarget(authority));
});

test('private proxy serves transport proof and forwards literal HTTP bodies without proxy credentials', async t => {
  let observed;
  const origin = http.createServer((req, res) => {
    let body = ''; req.on('data', part => body += part);
    req.on('end', () => { observed = { body, url: req.url, proxyAuthorization: req.headers['proxy-authorization'] }; res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(observed)); });
  });
  const port = await listen(origin);
  t.after(() => new Promise(resolve => origin.close(resolve)));
  const proxy = await startBrowserProxy();
  t.after(() => proxy.close());
  assert.equal((await lstat(proxy.socketPath)).mode & 0o777, 0o600);
  const health = await request(proxy.socketPath, 'http://ovm-browser-proxy.internal/health');
  assert.deepEqual(JSON.parse(health.body), { ok: true, transport: 'vsock_proxy' });
  const literal = "q=$(touch /bad); ' literal";
  const reply = await request(proxy.socketPath, `http://127.0.0.1:${port}/search?x=literal`, {
    method: 'POST', body: literal, headers: { 'content-length': Buffer.byteLength(literal), 'proxy-authorization': 'discard me' },
  });
  assert.equal(reply.status, 201);
  assert.equal(observed.body, literal);
  assert.equal(observed.url, '/search?x=literal');
  assert.equal(observed.proxyAuthorization, undefined);
  assert.equal(proxy.metrics.requests, 1);
});

test('CONNECT passes binary bytes unchanged and proxy close releases open tunnels', async t => {
  const origin = net.createServer(socket => socket.pipe(socket));
  const port = await listen(origin);
  t.after(() => new Promise(resolve => origin.close(resolve)));
  const proxy = await startBrowserProxy();
  const socket = net.connect(proxy.socketPath);
  await once(socket, 'connect');
  const response = new Promise((resolve, reject) => {
    socket.once('data', resolve); socket.once('error', reject);
  });
  socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  assert.match((await response).toString(), /^HTTP\/1.1 200/);
  const bytes = Buffer.from([0, 255, 22, 3, 3, 0, 254, 128, 2]);
  const echoed = once(socket, 'data'); socket.write(bytes);
  assert.deepEqual((await echoed)[0], bytes);
  const closed = once(socket, 'close');
  await proxy.close(); await closed;
  await assert.rejects(lstat(proxy.socketPath), { code: 'ENOENT' });
});

test('invalid proxy URLs and unreachable upstream yield concrete HTTP errors', async t => {
  const proxy = await startBrowserProxy(); t.after(() => proxy.close());
  assert.equal((await request(proxy.socketPath, 'file:///etc/passwd')).status, 400);
  assert.equal((await request(proxy.socketPath, 'http://user:password@example.com')).status, 400);
  const origin = net.createServer(); const port = await listen(origin); await new Promise(resolve => origin.close(resolve));
  assert.equal((await request(proxy.socketPath, `http://127.0.0.1:${port}/`)).status, 502);
});
