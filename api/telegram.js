// Вебхук Telegram: Vercel Serverless Function
import { createStore } from '../lib/store.js';
import { createTelegram } from '../lib/telegram.js';
import { handleUpdate } from '../lib/bot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('BOILER ROOM bot is alive');

  // Telegram присылает секрет из setWebhook в заголовке — отсекаем чужие запросы
  if (process.env.WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).end();
  }

  const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  try {
    await handleUpdate(update, {
      tg: createTelegram(process.env.TELEGRAM_BOT_TOKEN),
      store: createStore(),
      env: process.env,
      isAdmin: (chatId) =>
        (process.env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).includes(String(chatId)),
    });
  } catch (err) {
    // Telegram повторяет неподтверждённые апдейты, поэтому отвечаем 200 и логируем
    console.error('[webhook]', err);
  }
  return res.status(200).end();
}
