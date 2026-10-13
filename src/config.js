import { readFile } from 'node:fs/promises';
import { repositoryAllowlist } from './events.js';

export const credentialsPath = new URL('../.pingroom/credentials.json', import.meta.url);

export function loadEnv() {
  try { process.loadEnvFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .env.'); }
}

export async function loadCredentials(env = process.env, path = credentialsPath) {
  let token, room;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    token = env.PINGROOM_TOKEN; room = env.PINGROOM_ROOM;
  } else {
    try { ({ token, room } = JSON.parse(await readFile(path, 'utf8'))); }
    catch { throw new Error('Run npm run connect or provide both PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  }
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !room.trim()) {
    throw new Error('Provide both PINGROOM_TOKEN and PINGROOM_ROOM; partial credentials are never combined.');
  }
  return { token: token.trim(), room: room.trim() };
}

export async function loadConfig(env = process.env) {
  if (typeof env.GITHUB_WEBHOOK_SECRET !== 'string' || env.GITHUB_WEBHOOK_SECRET.trim().length < 32) {
    throw new Error('GITHUB_WEBHOOK_SECRET must contain at least 32 nonblank characters.');
  }
  const repositories = repositoryAllowlist(env.GITHUB_REPOSITORIES);
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  return { ...await loadCredentials(env), secret: env.GITHUB_WEBHOOK_SECRET, repositories, port, host: env.HOST || '127.0.0.1' };
}
