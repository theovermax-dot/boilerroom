// Самопроверка хранилища на живом сервере: чтение после записи и защита от одновременных изменений.
// Вызов: GET /api/selftest?key=<CRON_SECRET>  (тратит ~12 операций Blob, вызывать редко)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';

async function blobVersion() {
  try {
    return JSON.parse(await readFile(join(process.cwd(), 'node_modules/@vercel/blob/package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (!expected || key !== expected) return res.status(401).end();

  const store = createStore();
  const t0 = Date.now();
  try {
    await store.del('selftest');
    await store.set('selftest', { n: 0 });
    const back = await store.get('selftest');
    // Пять параллельных «+1»: если условная запись работает, в итоге будет ровно 5
    await Promise.all(Array.from({ length: 5 }, () => store.update('selftest', { n: 0 }, (v) => ({ n: v.n + 1 }))));
    const final = await store.get('selftest');
    await store.del('selftest');
    const gone = await store.get('selftest', 'deleted');
    return res.status(200).json({
      storage: store.kind,
      sdk: await blobVersion(),
      readAfterWriteOk: Boolean(back && back.n === 0),
      concurrentUpdatesOk: Boolean(final && final.n === 5),
      finalCounter: final && final.n,
      deleteOk: gone === 'deleted',
      ms: Date.now() - t0,
    });
  } catch (err) {
    return res.status(500).json({ storage: store.kind, error: String(err && err.message ? err.message : err) });
  }
}
