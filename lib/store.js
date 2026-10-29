// Хранилище бота. Три режима по приоритету:
//  1. Vercel Blob (приватное хранилище проекта, бесплатно на Hobby) — если задан BLOB_READ_WRITE_TOKEN
//  2. Upstash Redis REST — если заданы UPSTASH_REDIS_REST_* или KV_REST_API_*
//  3. Память процесса — только для локальных проверок и тестов
// Каждый ключ — отдельный JSON-файл, так что запись одного ключа не трогает остальные.

const memory = new Map();

const blobPath = (key) => `boilerroom/${encodeURIComponent(key)}.json`;

async function streamToText(stream) {
  return new Response(stream).text();
}

export function createStore(env = process.env) {
  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;

  if (blobToken) {
    let sdk;
    const load = async () => (sdk ||= await import('@vercel/blob'));
    return {
      kind: 'blob',
      async get(key, fallback = null) {
        const { get } = await load();
        const res = await get(blobPath(key), { access: 'private', token: blobToken, useCache: false });
        if (!res || res.statusCode !== 200) return fallback;
        const text = await streamToText(res.stream);
        return text ? JSON.parse(text) : fallback;
      },
      async set(key, value) {
        const { put } = await load();
        await put(blobPath(key), JSON.stringify(value), {
          access: 'private',
          token: blobToken,
          allowOverwrite: true,
          addRandomSuffix: false,
          contentType: 'application/json',
          cacheControlMaxAge: 60,
        });
      },
      async del(key) {
        const { del } = await load();
        try {
          await del(blobPath(key), { token: blobToken });
        } catch {
          // ключа может не быть — это нормально
        }
      },
      get isRemote() {
        return true;
      },
    };
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
    return {
      kind: 'redis',
      async get(key, fallback = null) {
        const raw = await command(['GET', key]);
        if (raw === undefined || raw === null) return fallback;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      },
      async set(key, value) {
        await command(['SET', key, JSON.stringify(value)]);
      },
      async del(key) {
        await command(['DEL', key]);
      },
      get isRemote() {
        return true;
      },
    };
  }

  return {
    kind: 'memory',
    async get(key, fallback = null) {
      const raw = memory.get(key);
      return raw === undefined ? fallback : JSON.parse(raw);
    },
    async set(key, value) {
      memory.set(key, JSON.stringify(value));
    },
    async del(key) {
      memory.delete(key);
    },
    get isRemote() {
      return false;
    },
  };
}
