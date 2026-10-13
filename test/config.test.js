import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCredentials, loadConfig } from '../src/config.js';

test('complete environment credentials bypass a bad saved file; partial values never combine', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await writeFile(path, 'not json');
  assert.deepEqual(await loadCredentials({ PINGROOM_TOKEN: 'new-token', PINGROOM_ROOM: 'ROOM' }, path), { token: 'new-token', room: 'ROOM' });
  await writeFile(path, JSON.stringify({ token: 'saved-token', room: 'SAVED' }));
  await assert.rejects(loadCredentials({ PINGROOM_TOKEN: 'new-token' }, path), /both/);
  await assert.rejects(loadCredentials({ PINGROOM_ROOM: 'ROOM' }, path), /both/);
  await assert.rejects(loadCredentials({ PINGROOM_TOKEN: ' ', PINGROOM_ROOM: 'ROOM' }, path), /both/);
  assert.deepEqual(await loadCredentials({}, path), { token: 'saved-token', room: 'SAVED' });
});

test('startup requires a long secret and explicit allowlist', async () => {
  await assert.rejects(loadConfig({ GITHUB_WEBHOOK_SECRET: 'short' }), /SECRET/);
  await assert.rejects(loadConfig({ GITHUB_WEBHOOK_SECRET: 'x'.repeat(32) }), /REPOSITORIES/);
  const config = await loadConfig({ GITHUB_WEBHOOK_SECRET: 'x'.repeat(32), GITHUB_REPOSITORIES: 'example/project', PINGROOM_TOKEN: 'token', PINGROOM_ROOM: 'ROOM' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
});
