// Тонкая обёртка над Telegram Bot API без внешних зависимостей.
export function createTelegram(token) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, body = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[telegram] ${method}: ${json.description}`);
      return null;
    }
    return json.result;
  }

  const common = { parse_mode: 'HTML', disable_web_page_preview: true };

  return {
    call,
    send(chatId, text, extra = {}) {
      return call('sendMessage', { chat_id: chatId, text, ...common, ...extra });
    },
    photo(chatId, photo, caption, extra = {}) {
      return call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });
    },
    editText(chatId, messageId, text, extra = {}) {
      return call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...common, ...extra });
    },
    answer(callbackId, text = '') {
      return call('answerCallbackQuery', { callback_query_id: callbackId, text });
    },
  };
}
