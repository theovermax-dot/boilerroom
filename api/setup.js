// Одноразовая настройка вебхука с сервера Vercel.
// Вызов: GET /api/setup?key=<CRON_SECRET>
import { createTelegram } from '../lib/telegram.js';
import { createStore } from '../lib/store.js';

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (!expected || key !== expected) return res.status(401).end();

  const tg = createTelegram(process.env.TELEGRAM_BOT_TOKEN);
  const base = process.env.PUBLIC_URL || `https://${req.headers.host}`;

  const me = await tg.call('getMe');
  const hook = await tg.call('setWebhook', {
    url: `${base}/api/telegram`,
    secret_token: process.env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const cmds = await tg.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Главное меню' },
      { command: 'book', description: 'Забронировать стол' },
      { command: 'cancel', description: 'Отменить действие' },
    ],
  });
  const info = await tg.call('getWebhookInfo');

  return res.status(200).json({
    bot: me ? `@${me.username}` : 'токен не принят Telegram',
    webhookSet: Boolean(hook),
    commandsSet: Boolean(cmds),
    webhookUrl: info ? info.url : null,
    pending: info ? info.pending_update_count : null,
    lastError: info ? info.last_error_message || null : null,
    storage: createStore().kind,
  });
}
