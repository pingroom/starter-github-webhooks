import { mkdir, chmod, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILE_BYTES = 200_000;

/** One process per directory. Hashes expire after 24h or the last 1000 sends. */
export async function openDeliveryStore(directory, { maxEntries = 1000, retentionMs = 86_400_000, now = Date.now } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000 || !Number.isFinite(retentionMs) || retentionMs < 1) {
    throw new Error('Invalid delivery store limits.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = join(directory, 'deliveries.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error('Delivery store is locked. Stop the other process; see README for crash recovery.'); }
  const path = join(directory, 'deliveries.json');
  const temporary = join(directory, 'deliveries.tmp');
  let delivered = new Map();
  let commitQueue = Promise.resolve();
  const pending = new Map();
  let closed = false;
  const prune = (entries) => new Map([...entries].filter(([, time]) => time > now() - retentionMs).slice(-maxEntries));
  try {
    await lock.writeFile(String(process.pid));
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('Delivery store exceeds its size limit.');
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(data) || data.length > 1000 || data.some((entry) => !Array.isArray(entry) || entry.length !== 2
        || !/^[a-f0-9]{64}$/.test(entry[0]) || !Number.isSafeInteger(entry[1]) || entry[1] < 0)) {
        throw new Error('Invalid delivery store. Restore a valid backup before starting.');
      }
      delivered = prune(new Map(data));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) {
    await lock.close();
    await rm(lockPath, { force: true });
    throw error;
  }

  async function commit(hash) {
    const updated = prune(new Map([...delivered, [hash, now()]]));
    const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify([...updated])); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    delivered = updated;
  }

  return {
    async deliver(hash, send) {
      if (closed) throw new Error('Delivery store is closed.');
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Expected a signed body hash.');
      delivered = prune(delivered);
      if (delivered.has(hash)) return { duplicate: true };
      if (pending.has(hash)) { await pending.get(hash); return { duplicate: true }; }
      if (pending.size >= 16) throw new Error('Too many pending deliveries.');
      const work = (async () => {
        await send();
        // Only successful sends reach the persistent record. Serialize atomic
        // replacements so simultaneous different events cannot lose records.
        const save = commitQueue.then(() => commit(hash));
        commitQueue = save.catch(() => {});
        await save;
      })();
      pending.set(hash, work);
      try { await work; return { duplicate: false }; }
      finally { pending.delete(hash); }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(pending.values());
      await lock.close();
      await rm(lockPath, { force: true });
      await rm(temporary, { force: true });
    },
  };
}
