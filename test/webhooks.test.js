import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { createWebhookServer } from '../src/server.js';
import { openDeliveryStore } from '../src/store.js';
import { validSignature, repositoryAllowlist } from '../src/events.js';
import { createOfflineClient, demoSecret, postExample, issuePayload } from '../src/offline.js';

async function setup(t, { offline = {}, serverOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-webhooks-test-'));
  const store = await openDeliveryStore(directory);
  const { client, pings } = createOfflineClient(offline);
  const server = createWebhookServer({ client, room: 'DEMO', secret: demoSecret, repositories: new Set(['example/project']), store, ...serverOptions });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, pings, url: `http://127.0.0.1:${server.address().port}` };
}

test('signature implementation matches the official GitHub test vector', () => {
  assert.equal(validSignature(Buffer.from('Hello, World!'), 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17', "It's a Secret to Everybody"), true);
});

test('valid signed issue and release deliveries become linked pings', async (t) => {
  const { url, pings } = await setup(t);
  const issue = await postExample(url);
  assert.equal(issue.status, 200);
  assert.equal((await issue.json()).status, 'delivered');
  const release = await postExample(url, { event: 'release', payload: {
    action: 'published', repository: { full_name: 'example/project' }, release: { tag_name: 'v2/preview', name: 'Version 2' },
  } });
  assert.equal(release.status, 200);
  assert.equal(pings.length, 2);
  assert.equal(pings[0].data.url, 'https://github.com/example/project/issues/42');
  assert.equal(pings[1].data.url, 'https://github.com/example/project/releases/tag/v2%2Fpreview');
});

test('missing, wrong, and malformed signatures cannot deliver', async (t) => {
  const { url, pings } = await setup(t);
  for (const signature of ['', 'sha256=bad', `sha256=${'0'.repeat(64)}`]) {
    assert.equal((await postExample(url, { headers: { 'x-hub-signature-256': signature } })).status, 401);
  }
  assert.equal(pings.length, 0);
});

test('raw whitespace changes invalidate an earlier signature', async (t) => {
  const { url, pings } = await setup(t);
  const body = JSON.stringify(issuePayload);
  const { createHmac } = await import('node:crypto');
  const signature = `sha256=${createHmac('sha256', demoSecret).update(body).digest('hex')}`;
  assert.equal((await postExample(url, { rawBody: `${body}\n`, headers: { 'x-hub-signature-256': signature } })).status, 401);
  assert.equal(pings.length, 0);
});

test('repository allowlist is required and enforced on signed requests', async (t) => {
  assert.throws(() => repositoryAllowlist(''), /GITHUB_REPOSITORIES/);
  assert.throws(() => repositoryAllowlist('*/*'), /GITHUB_REPOSITORIES/);
  assert.deepEqual(repositoryAllowlist('Example/Project'), new Set(['example/project']));
  const { url, pings } = await setup(t);
  assert.equal((await postExample(url, { payload: { ...issuePayload, repository: { full_name: 'other/repo' } } })).status, 403);
  assert.equal(pings.length, 0);
});

test('unselected event types and actions are acknowledged without sending', async (t) => {
  const { url, pings } = await setup(t);
  assert.equal((await postExample(url, { event: 'push' })).status, 202);
  assert.equal((await postExample(url, { payload: { ...issuePayload, action: 'closed' } })).status, 202);
  assert.equal((await postExample(url, { event: 'ping' })).status, 202);
  assert.equal(pings.length, 0);
});

test('invalid content type, encoding, JSON, and event payloads are rejected', async (t) => {
  const { url, pings } = await setup(t);
  assert.equal((await postExample(url, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await postExample(url, { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await postExample(url, { rawBody: '{broken' })).status, 400);
  assert.equal((await postExample(url, { payload: { ...issuePayload, issue: { number: '42', title: 'bad' } } })).status, 400);
  assert.equal((await postExample(url, { event: 'release', payload: { ...issuePayload, action: 'published' } })).status, 400);
  assert.equal(pings.length, 0);
});

test('body byte limit is enforced before delivery', async (t) => {
  const { url, pings } = await setup(t, { serverOptions: { maxBodyBytes: 64 } });
  assert.equal((await postExample(url)).status, 413);
  assert.equal(pings.length, 0);
});

test('streamed bodies cannot bypass the byte limit', async (t) => {
  const { url, pings } = await setup(t, { serverOptions: { maxBodyBytes: 64 } });
  const status = await new Promise((resolve, reject) => {
    const outgoing = request(`${url}/webhooks/github`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': '11111111-1111-4111-8111-111111111111' },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    outgoing.on('error', reject);
    outgoing.write('x'.repeat(40));
    outgoing.end('y'.repeat(40));
  });
  assert.equal(status, 413);
  assert.equal(pings.length, 0);
});

test('slow request bodies hit the read deadline', async (t) => {
  const { url, pings } = await setup(t, { serverOptions: { bodyTimeoutMs: 25 } });
  const status = await new Promise((resolve, reject) => {
    const outgoing = request(`${url}/webhooks/github`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': '11111111-1111-4111-8111-111111111111' },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    outgoing.on('error', reject);
    outgoing.write('{');
  });
  assert.equal(status, 408);
  assert.equal(pings.length, 0);
});

test('concurrent same-body deliveries and changed delivery IDs send once', async (t) => {
  let unblock;
  let started;
  const waiting = new Promise((resolve) => { unblock = resolve; });
  const sending = new Promise((resolve) => { started = resolve; });
  const { url, pings } = await setup(t, { offline: { beforeSend: async () => { started(); await waiting; } } });
  const first = postExample(url);
  await sending;
  const second = postExample(url);
  unblock();
  const responses = await Promise.all([first, second]);
  assert.deepEqual((await Promise.all(responses.map((res) => res.json()))).map((body) => body.status).sort(), ['already_delivered', 'delivered']);
  assert.equal((await (await postExample(url)).json()).status, 'already_delivered');
  assert.equal(pings.length, 1);
});

test('reusing an unsigned delivery ID for different signed bodies does not suppress events', async (t) => {
  const { url, pings } = await setup(t);
  const delivery = '11111111-1111-4111-8111-111111111111';
  await postExample(url, { delivery });
  await postExample(url, { delivery, payload: { ...issuePayload, issue: { number: 43, title: 'Second issue' } } });
  assert.equal(pings.length, 2);
});

test('failed sends do not mark a body delivered and a redelivery can succeed', async (t) => {
  let fail = true;
  const { url, pings } = await setup(t, { offline: { beforeSend: () => { if (fail) throw new Error('SECRET upstream failure body'); } } });
  const response = await postExample(url);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"status":"delivery_failed"}');
  fail = false;
  assert.equal((await (await postExample(url)).json()).status, 'delivered');
  assert.equal(pings.length, 1);
});

test('persistent records survive store restart and file locking prevents two writers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-store-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = await openDeliveryStore(directory);
  await assert.rejects(openDeliveryStore(directory), /locked/);
  const hash = createHash('sha256').update('signed body').digest('hex');
  await store.deliver(hash, async () => {});
  await store.close();
  store = await openDeliveryStore(directory);
  assert.deepEqual(await store.deliver(hash, () => assert.fail('must not resend')), { duplicate: true });
  await store.close();
});

test('delivery retention and entry count keep the store bounded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-store-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const store = await openDeliveryStore(directory, { maxEntries: 2, retentionMs: 100, now: () => now });
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  await Promise.all(['a', 'b', 'c'].map((value) => store.deliver(hash(value), async () => {})));
  assert.equal(JSON.parse(await readFile(join(directory, 'deliveries.json'), 'utf8')).length, 2);
  now += 101;
  let sends = 0;
  await store.deliver(hash('c'), async () => { sends++; });
  assert.equal(sends, 1);
  await store.close();
});

test('corrupt persisted state fails closed instead of silently losing replay history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-store-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'deliveries.json'), 'not valid json');
  await assert.rejects(openDeliveryStore(directory));
});

test('health endpoint works without webhook credentials in the request', async (t) => {
  const { url } = await setup(t);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/other`)).status, 404);
});
