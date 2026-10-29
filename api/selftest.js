// Самопроверка хранилища: пишет значение и сразу читает его, замеряя задержку.
// Вызов: GET /api/selftest?key=<CRON_SECRET>
import { createStore } from '../lib/store.js';

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (!expected || key !== expected) return res.status(401).end();

  const store = createStore();
  const results = [];
  try {
    for (let i = 1; i <= 6; i++) {
      const value = { n: i, t: Date.now() };
      const t0 = Date.now();
      await store.set('selftest', value);
      const back = await store.get('selftest');
      results.push({ round: i, readBackOk: back && back.n === i, ms: Date.now() - t0 });
    }
    await store.del('selftest');
    const gone = await store.get('selftest', 'deleted');
    return res.status(200).json({
      storage: store.kind,
      allReadAfterWriteOk: results.every((r) => r.readBackOk),
      deleteOk: gone === 'deleted',
      results,
    });
  } catch (err) {
    return res.status(500).json({ storage: store.kind, error: String(err && err.message ? err.message : err), results });
  }
}
