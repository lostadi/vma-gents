import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const HEALTH_HOST = 'ovm-browser-proxy.internal';

export function connectTarget(authority) {
  if (typeof authority !== 'string' || authority.length > 1024 || /[\s/@?#]/.test(authority)) throw new Error('Invalid CONNECT authority');
  const target = new URL(`http://${authority}`);
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  const port = Number(explicitPort);
  if (!explicitPort || !Number.isInteger(port) || port < 1 || port > 65535 || !target.hostname) throw new Error('CONNECT requires host:port');
  return { host: target.hostname.replace(/^\[|\]$/g, ''), port };
}

function upstreamHeaders(headers, target) {
  const result = { ...headers, host: target.host };
  for (const name of ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive']) delete result[name];
  return result;
}

/** Private Unix-socket HTTP proxy. HTTPS CONNECT passes TLS bytes unchanged. */
export async function startBrowserProxy() {
  // macOS AF_UNIX paths must fit sun_path; the normal TMPDIR can be too long.
  const directory = await mkdtemp('/tmp/ovm-web-');
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'proxy.sock');
  const sockets = new Set();
  const metrics = { connections: 0, requests: 0, tunnels: 0, healthRequests: 0, clientErrors: 0, transport: 'vsock_proxy' };
  const track = socket => {
    sockets.add(socket);
    socket.setTimeout(120000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => {
    let target;
    try {
      target = new URL(request.url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an absolute HTTP(S) URL without credentials');
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain', connection: 'close' }); response.end('Invalid proxy URL'); return;
    }
    if (target.hostname === HEALTH_HOST && target.pathname === '/health') {
      metrics.healthRequests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, transport: 'vsock_proxy' })); return;
    }
    metrics.requests++;
    const upstream = (target.protocol === 'https:' ? https : http).request(target, {
      method: request.method, headers: upstreamHeaders(request.headers, target), timeout: 120000,
    }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('socket', track);
    upstream.on('timeout', () => upstream.destroy(new Error('Proxy upstream timed out')));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
      response.end('Upstream connection failed');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.maxConnections = 32;
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.on('connection', socket => { metrics.connections++; track(socket); });
  server.on('clientError', (_error, socket) => {
    metrics.clientErrors++;
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy();
  });
  server.on('connect', (request, socket, head) => {
    let target;
    try { target = connectTarget(request.url); }
    catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    metrics.tunnels++;
    socket.pause();
    const upstream = track(net.connect(target));
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket); socket.resume();
    });
    upstream.once('error', () => {
      if (!connected && socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
  return { socketPath, metrics, async close() {
    const stopped = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  } };
}
