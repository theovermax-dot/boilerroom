// Хранилище бота. Три режима по приоритету:
//  1. Vercel Blob (приватное хранилище проекта, бесплатно на Hobby) — если задан BLOB_READ_WRITE_TOKEN
//  2. Upstash Redis REST — если заданы UPSTASH_REDIS_REST_* или KV_REST_API_*
//  3. Память процесса — только для локальных проверок и тестов
//
// Бесплатный Blob: 10 000 чтений и 2 000 записей в месяц, при превышении хранилище
// блокируется на 30 дней. Поэтому:
//  - удаление бесплатно, пустые записи не делаем;
//  - редко меняющиеся ключи можно читать через getCached (кэш в памяти тёплого инстанса);
//  - update() — атомарное «прочитать → изменить → записать» по ETag, без потери параллельных записей.

const memory = new Map();
const warmCache = new Map(); // `${kind}:${key}` → { value, at }

const blobPath = (key) => `boilerroom/${encodeURIComponent(key)}.json`;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function streamToText(stream) {
  return new Response(stream).text();
}

// Общая обвязка: кэш и update поверх примитивов конкретного бэкенда
function finish(kind, prim, remote = true) {
  const ck = (key) => `${kind}:${key}`;
  const remember = (key, value) => warmCache.set(ck(key), { value: clone(value), at: Date.now() });
  return {
    kind,
    get isRemote() {
      return remote;
    },
    stats: prim.stats,
    async get(key, fallback = null) {
      const { value } = await prim.read(key);
      return value === undefined ? fallback : value;
    },
    async getCached(key, fallback = null, ttlMs = 30_000) {
      const hit = warmCache.get(ck(key));
      if (hit && Date.now() - hit.at < ttlMs) return hit.value === undefined ? fallback : clone(hit.value);
      const { value } = await prim.read(key);
      remember(key, value);
      return value === undefined ? fallback : value;
    },
    async set(key, value) {
      await prim.write(key, value, null);
      remember(key, value);
    },
    async del(key) {
      warmCache.delete(ck(key));
      await prim.remove(key);
    },
    // fn получает текущее значение (или fallback) и возвращает новое; undefined — ничего не записывать
    async update(key, fallback, fn) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const { value, etag } = await prim.read(key);
        const current = value === undefined ? clone(fallback) : value;
        const next = await fn(current);
        if (next === undefined) {
          remember(key, value);
          return current;
        }
        const ok = await prim.write(key, next, etag === undefined ? 'absent' : etag);
        if (ok) {
          remember(key, next);
          return next;
        }
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (attempt + 1)));
      }
      throw new Error(`store.update(${key}): слишком много одновременных изменений`);
    },
  };
}

export function createStore(env = process.env) {
  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;

  if (blobToken) {
    let sdk;
    const load = async () => (sdk ||= await import('@vercel/blob'));
    const stats = { reads: 0, writes: 0 };
    return finish('blob', {
      stats,
      async read(key) {
        const { get } = await load();
        stats.reads++;
        const res = await get(blobPath(key), { access: 'private', token: blobToken, useCache: false });
        if (!res || res.statusCode !== 200) return { value: undefined, etag: undefined };
        const text = await streamToText(res.stream);
        return { value: text ? JSON.parse(text) : undefined, etag: res.blob && res.blob.etag };
      },
      // expect: null — перезаписать без условий; 'absent' — только если ключа нет; иначе ETag
      async write(key, value, expect) {
        const { put } = await load();
        const opts = {
          access: 'private',
          token: blobToken,
          addRandomSuffix: false,
          contentType: 'application/json',
          cacheControlMaxAge: 60,
        };
        if (expect === 'absent') opts.allowOverwrite = false;
        else if (expect) opts.ifMatch = expect;
        else opts.allowOverwrite = true;
        stats.writes++;
        try {
          await put(blobPath(key), JSON.stringify(value), opts);
          return true;
        } catch (err) {
          const name = (err && err.constructor && err.constructor.name) || '';
          const msg = String((err && err.message) || '');
          if (expect && (name === 'BlobPreconditionFailedError' || /precondition|already exists/i.test(msg))) return false;
          throw err;
        }
      },
      async remove(key) {
        const { del } = await load();
        try {
          await del(blobPath(key), { token: blobToken });
        } catch {
          // ключа может не быть — это нормально
        }
      },
    });
  }

  if (redisUrl && redisToken) {
    const command = async (args) => {
      const res = await fetch(redisUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const json = await res.json();
      if (json.error) throw new Error(`Upstash: ${json.error}`);
      return json.result;
    };
    // В Redis нет ETag: версия = само значение, сравнение через Lua-скрипт
    const CAS = "local v=redis.call('GET',KEYS[1]); if (v==false and ARGV[1]=='') or v==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end; return 0";
    return finish('redis', {
      async read(key) {
        const raw = await command(['GET', key]);
        if (raw === undefined || raw === null) return { value: undefined, etag: undefined };
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return { value: JSON.parse(text), etag: text };
      },
      async write(key, value, expect) {
        const text = JSON.stringify(value);
        if (!expect) {
          await command(['SET', key, text]);
          return true;
        }
        const r = await command(['EVAL', CAS, 1, key, expect === 'absent' ? '' : expect, text]);
        return Number(r) === 1;
      },
      async remove(key) {
        await command(['DEL', key]);
      },
    });
  }

  // Память процесса. В тестах можно передать свой Map в env.__memory, чтобы сценарии не мешали друг другу
  const space = env.__memory || memory;
  const stats = { reads: 0, writes: 0 };
  return finish(env.__memory ? `memory#${env.__memoryId}` : 'memory', {
    stats,
    async read(key) {
      stats.reads++;
      const raw = space.get(key);
      return raw === undefined ? { value: undefined, etag: undefined } : { value: JSON.parse(raw), etag: raw };
    },
    async write(key, value, expect) {
      const raw = space.get(key);
      if (expect === 'absent' && raw !== undefined) return false;
      if (expect && expect !== 'absent' && raw !== expect) return false;
      stats.writes++;
      space.set(key, JSON.stringify(value));
      return true;
    },
    async remove(key) {
      space.delete(key);
    },
  }, false);
}
