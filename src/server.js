import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { RequestError, eventPing, validSignature } from './events.js';

function readBody(request, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const finish = (error) => {
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('error', fail);
      request.removeListener('aborted', aborted);
      if (error) { request.pause(); reject(error); }
      else resolve(Buffer.concat(chunks, length));
    };
    const data = (chunk) => {
      length += chunk.length;
      if (length > maxBytes) finish(new RequestError(413, 'body_too_large'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish(new RequestError(400, 'body_read_failed'));
    const aborted = () => finish(new RequestError(400, 'body_aborted'));
    const timer = setTimeout(() => finish(new RequestError(408, 'body_timeout')), timeoutMs);
    request.on('data', data).once('end', end).once('error', fail).once('aborted', aborted);
  });
}

export function createWebhookServer({ client, room, secret, repositories, store, maxBodyBytes = 262_144, bodyTimeoutMs = 2000 }) {
  if (typeof secret !== 'string' || secret.length < 32 || !(repositories instanceof Set) || repositories.size === 0 || !room) {
    throw new Error('Provide a secret of at least 32 characters, a repository allowlist, and a PingRoom room.');
  }
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const reply = (status, code) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ status: code }));
    };
    response.once('finish', () => request.destroy());
    if (request.method === 'GET' && request.url === '/health') { reply(200, 'ok'); return; }
    if (request.method !== 'POST' || request.url !== '/webhooks/github') { reply(404, 'not_found'); return; }
    if (active >= 16) { reply(503, 'busy'); return; }
    active++;
    const deadline = setTimeout(() => reply(503, 'delivery_timeout'), 8000);
    try {
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) {
        throw new RequestError(415, 'unsupported_content_type');
      }
      if (Number(request.headers['content-length']) > maxBodyBytes) throw new RequestError(413, 'body_too_large');
      const event = request.headers['x-github-event'];
      if (typeof event !== 'string' || !/^[a-z_]{1,50}$/.test(event)) throw new RequestError(400, 'invalid_event_header');
      const delivery = request.headers['x-github-delivery'];
      if (typeof delivery !== 'string' || !/^[a-f0-9-]{36}$/i.test(delivery)) throw new RequestError(400, 'invalid_delivery_header');
      const body = await readBody(request, maxBodyBytes, bodyTimeoutMs);
      if (!validSignature(body, request.headers['x-hub-signature-256'], secret)) throw new RequestError(401, 'invalid_signature');
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw new RequestError(400, 'invalid_json'); }
      const ping = eventPing(event, payload, repositories);
      if (!ping) { reply(202, 'ignored_event'); return; }
      // GitHub signs only the raw body. Delivery/event headers are unsigned;
      // using the body hash also prevents a replay with a changed delivery ID.
      const hash = createHash('sha256').update(body).digest('hex');
      const outcome = await store.deliver(hash, () => client.broadcast(room, ping));
      reply(200, outcome.duplicate ? 'already_delivered' : 'delivered');
    } catch (error) {
      reply(error instanceof RequestError ? error.status : 503, error instanceof RequestError ? error.code : 'delivery_failed');
    } finally {
      clearTimeout(deadline);
      active--;
    }
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.headersTimeout = 3000;
  server.requestTimeout = 7000;
  server.keepAliveTimeout = 1000;
  return server;
}
