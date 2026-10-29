// Хранилище. В продакшене — Upstash Redis (бесплатный тариф, REST API).
// Без переменных окружения работает в памяти: удобно для локальных проверок,
// но данные сбрасываются при перезапуске сервера.

const memory = new Map();

export function createStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const useRemote = Boolean(url && token);

  async function command(args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const json = await res.json();
    if (json.error) throw new Error(`Upstash: ${json.error}`);
    return json.result;
  }

  return {
    async get(key, fallback = null) {
      const raw = useRemote ? await command(['GET', key]) : memory.get(key);
      if (raw === undefined || raw === null) return fallback;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    async set(key, value) {
      const raw = JSON.stringify(value);
      if (useRemote) await command(['SET', key, raw]);
      else memory.set(key, raw);
    },
    async del(key) {
      if (useRemote) await command(['DEL', key]);
      else memory.delete(key);
    },
    get isRemote() {
      return useRemote;
    },
  };
}
