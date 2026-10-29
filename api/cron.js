// Напоминания: дергается по расписанию из GitHub Actions (бесплатно)
import { createStore } from '../lib/store.js';
import { createTelegram } from '../lib/telegram.js';
import { runReminders } from '../lib/bot.js';

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).end();
  }
  try {
    const report = await runReminders({
      tg: createTelegram(process.env.TELEGRAM_BOT_TOKEN),
      store: createStore(),
      env: process.env,
    });
    return res.status(200).json({ ok: true, ...report });
  } catch (err) {
    console.error('[cron]', err);
    return res.status(500).json({ ok: false });
  }
}
