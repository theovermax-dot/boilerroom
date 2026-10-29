// Одноразовая настройка: регистрирует вебхук и команды бота.
// Запуск: TELEGRAM_BOT_TOKEN=... PUBLIC_URL=https://your-app.vercel.app WEBHOOK_SECRET=... node scripts/setup-webhook.mjs
const { TELEGRAM_BOT_TOKEN: token, PUBLIC_URL: publicUrl, WEBHOOK_SECRET: secret } = process.env;

if (!token || !publicUrl || !secret) {
  console.error('Нужны TELEGRAM_BOT_TOKEN, PUBLIC_URL и WEBHOOK_SECRET');
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const me = await api('getMe', {});
console.log('Бот:', me.ok ? `@${me.result.username}` : me.description);

const hook = await api('setWebhook', {
  url: `${publicUrl}/api/telegram`,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
console.log('Вебхук:', hook.ok ? 'установлен' : hook.description);

const cmds = await api('setMyCommands', {
  commands: [
    { command: 'start', description: 'Главное меню' },
    { command: 'book', description: 'Забронировать стол' },
    { command: 'cancel', description: 'Отменить действие' },
  ],
});
console.log('Команды:', cmds.ok ? 'обновлены' : cmds.description);
