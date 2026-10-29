import { VENUE, EVENT_GRACE_HOURS, BOOKING_REMINDER_MINUTES, WEEKLY_REMINDER_HOUR } from './config.js';
import { MENU, IMG_BASE, CURRENCY } from './menu.js';
import {
  formatEventTime,
  weekdayName,
  extractDateTime,
  parseLocalDate,
  localDateKey,
  localWeekday,
  localHour,
} from './time.js';

// ---------- утилиты ----------

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

const PHONE_RE = /^\+?[\d\s()-]{7,20}$/;

const BTN = {
  BOOK: '🏟 Забронировать стол',
  EVENTS: '📅 Трансляции',
  PROMOS: '🎁 Акции',
  MENU: '🍽 Меню',
  INFO: '📍 Адрес и часы',
  ADMIN: '⚙️ Админ-панель',
  CANCEL: '❌ Отмена',
  SKIP_PHOTO: '⏭ Без фото',
  CONTACT: '📱 Отправить номер',
};

const guestKeyboard = {
  keyboard: [
    [{ text: BTN.BOOK }],
    [{ text: BTN.EVENTS }, { text: BTN.PROMOS }],
    [{ text: BTN.MENU }, { text: BTN.INFO }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const adminKeyboard = {
  keyboard: [...guestKeyboard.keyboard, [{ text: BTN.ADMIN }]],
  resize_keyboard: true,
  is_persistent: true,
};

const cancelKeyboard = { keyboard: [[{ text: BTN.CANCEL }]], resize_keyboard: true };
const photoKeyboard = { keyboard: [[{ text: BTN.SKIP_PHOTO }], [{ text: BTN.CANCEL }]], resize_keyboard: true };
const contactKeyboard = {
  keyboard: [[{ text: BTN.CONTACT, request_contact: true }], [{ text: BTN.CANCEL }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

const inline = (rows) => ({ inline_keyboard: rows });

// ---------- хранение ----------
// Трансляции, акции и заявки лежат в одном документе `db`: одно чтение на запрос и одно на запуск
// напоминаний. Изменения идут через store.update (по ETag), поэтому одновременные брони не теряются.

const SESSION_TTL_MS = 2 * 3600e3;
const normalizeDb = (d) => ({
  events: Array.isArray(d && d.events) ? d.events : [],
  promos: Array.isArray(d && d.promos) ? d.promos : [],
  bookings: Array.isArray(d && d.bookings) ? d.bookings : [],
});

function makeDb(store, now = new Date()) {
  // Старые версии хранили всё в отдельных ключах — переносим один раз
  const legacy = async () =>
    normalizeDb({
      events: await store.get('events', []),
      promos: await store.get('promos', []),
      bookings: await store.get('bookings', []),
    });
  const ensure = async (raw) => {
    if (raw) return normalizeDb(raw);
    const created = await store.update('db', null, async (cur) => (cur ? undefined : legacy()));
    return normalizeDb(created);
  };
  let memo = null;
  return {
    // fresh=false: можно отдать копию из тёплого кэша (до 20 с) — для показа списков гостям
    async data({ fresh = true } = {}) {
      if (memo) return memo;
      const raw = fresh ? await store.get('db', null) : await store.getCached('db', null, 20_000);
      memo = await ensure(raw);
      return memo;
    },
    // fn меняет документ на месте; вернуть false — ничего не записывать
    async mutate(fn) {
      let result;
      const saved = await store.update('db', null, async (cur) => {
        const d = cur ? normalizeDb(cur) : await legacy();
        result = await fn(d);
        return result === false ? undefined : d;
      });
      memo = normalizeDb(saved);
      return result;
    },
    users: () => store.get('users', {}),
    async touchUser(chatId, from) {
      await store.update('users', {}, (u) => {
        if (u[chatId]) return undefined; // уже знаем — без лишней записи
        u[chatId] = { name: from.first_name || '', username: from.username || '', since: now.toISOString() };
        return u;
      });
    },
    async session(chatId) {
      const s = await store.get(`s:${chatId}`, null);
      if (!s) return null;
      if (s.at && now.getTime() - new Date(s.at).getTime() > SESSION_TTL_MS) return null; // забытый сценарий
      return s;
    },
    saveSession: (chatId, v) => store.set(`s:${chatId}`, { ...v, at: now.toISOString() }),
    clearSession: (chatId) => store.del(`s:${chatId}`), // удаление в Blob бесплатное
  };
}

const eventCutoff = (now) => now.getTime() - EVENT_GRACE_HOURS * 3600e3;
const aliveEvents = (d, now) =>
  d.events
    .filter((e) => new Date(e.startsAt).getTime() > eventCutoff(now))
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
const alivePromos = (d, now) => d.promos.filter((p) => p.kind === 'weekly' || new Date(p.until) >= now);

async function activeEvents(db, now, opts) {
  return aliveEvents(await db.data(opts), now);
}

async function activePromos(db, now, opts) {
  return alivePromos(await db.data(opts), now);
}

const peopleLabel = (n) => (n === 7 ? '7 и больше' : String(n));

// Фото с подписью, а если Telegram не принял картинку — тот же текст сообщением
async function photoOrText(tg, chatId, photo, caption, extra = {}) {
  if (photo) {
    const sent = await tg.photo(chatId, photo, caption, extra);
    if (sent) return sent;
  }
  return tg.send(chatId, caption, extra);
}

function eventCaption(e) {
  return `<b>${esc(e.title)}</b>\n🗓 ${formatEventTime(e.startsAt)}\n\nБронь стола — по кнопке ниже 👇`;
}

const EVERY_WEEKDAY = ['каждое воскресенье', 'каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу'];

function promoWhen(p) {
  if (p.kind === 'weekly') return EVERY_WEEKDAY[p.weekday] || `по дням: ${weekdayName(p.weekday)}`;
  return `до ${localDateKey(new Date(p.until)).slice(5).split('-').reverse().join('.')} включительно`;
}

function promoCaption(p) {
  return `🎁 <b>${esc(p.title)}</b>\n${p.text ? `${esc(p.text)}\n` : ''}\n🗓 ${promoWhen(p)}`;
}

function menuFor(isAdmin) {
  return isAdmin ? adminKeyboard : guestKeyboard;
}

// ---------- гостевые сценарии ----------

const NO_EVENTS = 'Ближайших трансляций пока нет. Загляните позже — мы обязательно добавим матчи 🙌';

async function sendWelcome({ tg, env, chatId, isAdmin }) {
  const welcomeText =
    `<b>${esc(VENUE.name)} ${esc(VENUE.city)}</b>\n\n` +
    `Здесь можно забронировать стол на футбол, UFC и бокс — без звонков, а ещё посмотреть меню с ценами и фото.\n\n` +
    `Выберите действие в меню 👇`;
  const photo = env.PUBLIC_URL ? `${env.PUBLIC_URL}/img/welcome.jpg` : null;
  return photoOrText(tg, chatId, photo, welcomeText, { reply_markup: menuFor(isAdmin) });
}

async function showEvents({ tg, db, env, chatId, now }) {
  const events = (await activeEvents(db, now, { fresh: false })).slice(0, 6);
  if (!events.length) return tg.send(chatId, NO_EVENTS);
  for (const e of events) {
    const photo = e.photo || (env.PUBLIC_URL ? `${env.PUBLIC_URL}/img/cover.jpg` : null);
    await photoOrText(tg, chatId, photo, eventCaption(e), {
      reply_markup: inline([[{ text: '🏟 Забронировать стол', callback_data: `bk:${e.id}` }]]),
    });
  }
}

async function showPromos({ tg, db, chatId, now }) {
  const promos = await activePromos(db, now, { fresh: false });
  if (!promos.length) return tg.send(chatId, 'Сейчас активных акций нет. Следите за обновлениями!');
  for (const p of promos) await photoOrText(tg, chatId, p.photo, promoCaption(p));
}

async function showInfo({ tg, chatId }) {
  await tg.send(
    chatId,
    `<b>${esc(VENUE.name)} ${esc(VENUE.city)}</b>\n\n📍 ${esc(VENUE.address)}\n🕘 ${esc(VENUE.hours)}\n📞 ${esc(VENUE.phone)}\n🌐 ${esc(VENUE.website)}\n📸 ${esc(VENUE.instagram)}`,
  );
  if (tg.call && VENUE.latitude) {
    await tg.call('sendLocation', { chat_id: chatId, latitude: VENUE.latitude, longitude: VENUE.longitude });
  }
}

async function startBooking({ tg, db, chatId, now }) {
  const events = await activeEvents(db, now, { fresh: false });
  if (!events.length) return tg.send(chatId, NO_EVENTS);
  const rows = events.map((e) => [{ text: `${formatEventTime(e.startsAt)} · ${e.title}`.slice(0, 60), callback_data: `bk:${e.id}` }]);
  return tg.send(chatId, 'Выберите трансляцию для брони 👇', { reply_markup: inline(rows) });
}

// ---------- меню ----------

const money = (n) => `${n} ${CURRENCY}`;

function menuRootKeyboard() {
  const rows = [];
  for (let i = 0; i < MENU.length; i += 2) {
    rows.push(MENU.slice(i, i + 2).map((c, j) => ({ text: `${c.emoji} ${c.title}`, callback_data: `mc:${i + j}` })));
  }
  rows.push([{ text: '🏟 Забронировать стол', callback_data: 'bkl' }]);
  return inline(rows);
}

const MENU_ROOT_TEXT = `🍽 <b>Меню ${esc(VENUE.name)}</b>\n\nВыберите раздел. Цены в лари (${CURRENCY}), по каждой позиции есть фото.`;

// Показать текстовый экран: отредактировать текущее сообщение, а если это карточка с фото —
// прислать новое и убрать карточку, чтобы в чате не копились дубли.
async function replaceOrSend(tg, chatId, messageId, text, markup, isPhoto = false) {
  if (messageId && !isPhoto) {
    const edited = await tg.editText(chatId, messageId, text, { reply_markup: markup });
    if (edited) return edited;
  }
  const sent = await tg.send(chatId, text, { reply_markup: markup });
  if (sent && messageId && tg.call) await tg.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  return sent;
}

function showMenuRoot({ tg, chatId, messageId = null, isPhoto = false }) {
  return replaceOrSend(tg, chatId, messageId, MENU_ROOT_TEXT, menuRootKeyboard(), isPhoto);
}

function categoryView(ci) {
  const cat = MENU[ci];
  const lines = cat.items.map(([name, price, portion]) => `• ${esc(name)} — <b>${money(price)}</b>${portion ? ` · ${esc(portion)}` : ''}`);
  const text = `${cat.emoji} <b>${esc(cat.title)}</b>\n\n${lines.join('\n')}\n\n<i>Нажмите на позицию, чтобы посмотреть фото.</i>`;
  const rows = [];
  for (let i = 0; i < cat.items.length; i += 2) {
    rows.push(
      cat.items.slice(i, i + 2).map(([name, price], j) => ({
        text: `${name.length > 22 ? name.slice(0, 21) + '…' : name} · ${price}`,
        callback_data: `mi:${ci}.${i + j}`,
      })),
    );
  }
  rows.push([{ text: '⬅️ Все разделы', callback_data: 'mn' }]);
  return { text, markup: inline(rows) };
}

function showMenuCategory({ tg, chatId, ci, messageId = null, isPhoto = false }) {
  if (!Number.isInteger(ci) || !MENU[ci]) return showMenuRoot({ tg, chatId, messageId, isPhoto });
  const { text, markup } = categoryView(ci);
  return replaceOrSend(tg, chatId, messageId, text, markup, isPhoto);
}

async function showMenuItem({ tg, chatId, ci, ii, messageId = null }) {
  const cat = MENU[ci];
  const item = cat && cat.items[ii];
  if (!item) return showMenuRoot({ tg, chatId, messageId });
  const [name, price, portion, img] = item;
  const caption = `<b>${esc(name)}</b>\n${money(price)}${portion ? ` · ${esc(portion)}` : ''}\n\n<i>${cat.emoji} ${esc(cat.title)}</i>`;
  const markup = inline([
    [{ text: `⬅️ ${cat.title}`, callback_data: `mc:${ci}` }, { text: '🍽 Меню', callback_data: 'mn' }],
    [{ text: '🏟 Забронировать стол', callback_data: 'bkl' }],
  ]);
  return photoOrText(tg, chatId, `${IMG_BASE}${img}`, caption, { reply_markup: markup });
}

// ---------- админка ----------

function adminPanel() {
  return inline([
    [
      { text: '➕ Трансляция', callback_data: 'adm:ev' },
      { text: '➕ Акция', callback_data: 'adm:pr' },
    ],
    [
      { text: '📋 Заявки', callback_data: 'adm:bk' },
      { text: '🗓 Расписание', callback_data: 'adm:sc' },
    ],
    [{ text: '📢 Рассылка всем', callback_data: 'adm:bc' }],
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Рассылка всем, кто запускал бота. Telegram пускает ~30 сообщений в секунду — шлём пачками по 20 с паузой.
async function broadcast({ tg, db, payload }) {
  const users = Object.keys(await db.users());
  let sent = 0;
  for (let i = 0; i < users.length; i += 20) {
    if (i) await sleep(1100);
    const chunk = users.slice(i, i + 20);
    const results = await Promise.all(chunk.map((id) => photoOrText(tg, id, payload.photo, payload.text, payload.extra || {})));
    sent += results.filter(Boolean).length;
  }
  return sent;
}

async function notifyAdmins({ tg, adminIds, text, extra = {} }) {
  for (const id of adminIds) await tg.send(id, text, extra);
}

function bookingCard(b, e) {
  return (
    `🆕 <b>Заявка на бронь</b>\n` +
    `Трансляция: ${esc(e ? e.title : 'удалена')}${e ? ` (${formatEventTime(e.startsAt)})` : ''}\n` +
    `Гостей: ${peopleLabel(b.people)}\n` +
    `Имя: ${esc(b.name)}\n` +
    `Телефон: ${esc(b.phone)}` +
    (b.username ? `\nTelegram: @${esc(b.username)}` : '')
  );
}

const decisionButtons = (id) =>
  inline([[
    { text: '✅ Подтвердить', callback_data: `ok:${id}` },
    { text: '✖️ Отклонить', callback_data: `no:${id}` },
  ]]);

async function listBookings({ tg, db, chatId }) {
  const d = await db.data();
  const pending = d.bookings.filter((b) => b.status === 'pending');
  if (!pending.length) return tg.send(chatId, 'Новых заявок нет ✅');
  for (const b of pending) {
    const e = d.events.find((x) => x.id === b.eventId);
    await tg.send(chatId, bookingCard(b, e), { reply_markup: decisionButtons(b.id) });
  }
}

async function listSchedule({ tg, db, chatId, now }) {
  const d = await db.data();
  const events = aliveEvents(d, now);
  const promos = alivePromos(d, now);
  if (!events.length && !promos.length) return tg.send(chatId, 'Расписание пустое. Добавьте трансляцию или акцию.');
  for (const e of events) {
    const booked = d.bookings.filter((b) => b.eventId === e.id && b.status === 'confirmed');
    const guests = booked.reduce((n, b) => n + Number(b.people || 0), 0);
    await tg.send(
      chatId,
      `🏟 <b>${esc(e.title)}</b>\n${formatEventTime(e.startsAt)}${e.photo ? ' · 🖼 с афишей' : ''}\nПодтверждено броней: ${booked.length}${booked.length ? ` (гостей ~${guests})` : ''}`,
      {
        reply_markup: inline([[
          { text: '📢 Анонсировать', callback_data: `ann:${e.id}` },
          { text: '🗑 Удалить', callback_data: `dl:${e.id}` },
        ]]),
      },
    );
  }
  for (const p of promos) {
    await tg.send(chatId, `🎁 <b>${esc(p.title)}</b>\n${promoWhen(p)}`, {
      reply_markup: inline([[
        { text: '📢 Анонсировать', callback_data: `pann:${p.id}` },
        { text: '🗑 Удалить', callback_data: `dp:${p.id}` },
      ]]),
    });
  }
}

const EVENT_PROMPT =
  '➕ <b>Новая трансляция</b>\n\n' +
  'Отправьте <b>одним сообщением</b> название, дату и время (по Батуми). ' +
  'Афишу можно приложить к этому же сообщению, это по желанию.\n\n' +
  'Примеры:\n' +
  '• Барселона — Реал, 01.11 21:00\n' +
  '• UFC главный бой завтра 23:00';

const DATE_ERRORS = {
  nodate: 'Не нашёл дату и время. Напишите, например: <b>Барселона — Реал, 01.11 21:00</b> или <b>UFC завтра 23:00</b>.',
  date: 'Такой даты нет в календаре. Проверьте день и месяц.',
  time: 'Время указано неверно. Формат: 21:00.',
  past: 'Эта дата уже прошла. Укажите ближайшую.',
  notitle: 'Не хватает названия. Напишите название и рядом дату со временем.',
};

// Создаёт трансляцию из одного сообщения. Возвращает false, если разобрать не удалось.
async function quickEvent({ db, ctx, chatId, input, photo, silent = false }) {
  const { tg, now } = ctx;
  const parsed = extractDateTime(input, now);
  const error = parsed.error || (!parsed.title ? 'notitle' : null);
  if (error) {
    if (!silent) await tg.send(chatId, DATE_ERRORS[error], { reply_markup: cancelKeyboard });
    return false;
  }
  const event = { id: newId(), title: parsed.title, startsAt: parsed.startsAt, photo: photo || null, createdAt: now.toISOString() };
  await db.mutate((d) => {
    d.events.push(event);
  });
  await db.clearSession(chatId);
  const soon = new Date(event.startsAt).getTime() < now.getTime() ? '\n⚠️ Время уже наступило — проверьте дату.' : '';
  await tg.send(
    chatId,
    `✅ Трансляция добавлена: <b>${esc(event.title)}</b>\n🗓 ${formatEventTime(event.startsAt)}${event.photo ? '\n🖼 с афишей' : ''}${soon}\n\nГости уже видят её и могут бронировать стол.`,
    {
      reply_markup: inline([
        [{ text: '📢 Анонсировать всем', callback_data: `ann:${event.id}` }],
        [{ text: '➕ Добавить ещё', callback_data: 'adm:ev' }, { text: '🗑 Удалить', callback_data: `dl:${event.id}` }],
      ]),
    },
  );
  // Возвращаем админу обычную клавиатуру (после «Отмены» в сценарии)
  await tg.send(chatId, 'Готово 👌', { reply_markup: adminKeyboard });
  return true;
}

const WEEKDAY_BUTTONS = [
  [1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс'],
];

// ---------- маршрутизация сообщений ----------

async function onMessage(msg, ctx) {
  const { tg, env, now } = ctx;
  const db = makeDb(ctx.store, now);
  const chatId = msg.chat.id;
  // Бот работает только в личных сообщениях
  if (msg.chat.type && msg.chat.type !== 'private') return;
  const isAdmin = ctx.isAdmin(chatId);
  const text = (msg.text || '').trim();

  // Первый вход админа: /admin <ADMIN_CODE>. Код знает только владелец.
  if (/^\/admin(@\w+)?\s+\S+/.test(text) && env.ADMIN_CODE) {
    if (tg.call) await tg.call('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    if (text.split(/\s+/)[1] === env.ADMIN_CODE) {
      await ctx.store.update('admins', [], (list) => {
        if (list.map(String).includes(String(chatId))) return undefined;
        list.push(chatId);
        return list;
      });
      await db.touchUser(chatId, msg.from || {});
      await db.clearSession(chatId);
      return tg.send(chatId, '✅ Вы подключены как администратор. Откройте «⚙️ Админ-панель».', { reply_markup: adminKeyboard });
    }
    return tg.send(chatId, 'Неверный код.', { reply_markup: menuFor(isAdmin) });
  }

  // Команды могут прийти как «/start@BoilerRoomBatumi_bot» или «/start payload»
  const command = text.startsWith('/') ? text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase() : null;

  const reset = async () => db.clearSession(chatId);
  const menuActions = {
    '/start': async () => {
      await db.touchUser(chatId, msg.from || {});
      return sendWelcome({ tg, env, chatId, isAdmin });
    },
    '/cancel': () => tg.send(chatId, 'Отменено.', { reply_markup: menuFor(isAdmin) }),
    [BTN.CANCEL]: () => tg.send(chatId, 'Отменено.', { reply_markup: menuFor(isAdmin) }),
    '/book': () => startBooking({ tg, db, chatId, now }),
    [BTN.BOOK]: () => startBooking({ tg, db, chatId, now }),
    [BTN.EVENTS]: () => showEvents({ tg, db, env, chatId, now }),
    [BTN.PROMOS]: () => showPromos({ tg, db, chatId, now }),
    [BTN.MENU]: () => showMenuRoot({ tg, chatId }),
    '/menu': () => showMenuRoot({ tg, chatId }),
    [BTN.INFO]: () => showInfo({ tg, chatId }),
  };
  if (isAdmin) {
    menuActions['/admin'] = () => tg.send(chatId, 'Админ-панель', { reply_markup: adminPanel() });
    menuActions[BTN.ADMIN] = menuActions['/admin'];
  }

  const action = menuActions[text] || (command && menuActions[command]);
  if (action) {
    await reset(); // любая кнопка меню или команда прерывает незавершённый сценарий
    return action();
  }

  const session = await db.session(chatId);
  if (session && session.step) {
    return handleStep({ msg, text, session, db, ctx, chatId, isAdmin });
  }

  // Быстрый путь для админа: сообщение вида «Барселона — Реал 01.11 21:00» (можно с фото) сразу создаёт трансляцию
  if (isAdmin) {
    const input = (text || msg.caption || '').trim();
    const photo = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    if (input && (await quickEvent({ db, ctx, chatId, input, photo, silent: true }))) return;
  }

  return tg.send(chatId, 'Выберите действие в меню 👇', { reply_markup: menuFor(isAdmin) });
}

// ---------- пошаговые сценарии ----------

async function handleStep({ msg, text, session, db, ctx, chatId, isAdmin }) {
  const { tg, now } = ctx;
  const photoId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;

  switch (session.step) {
    // Гость: имя → телефон → заявка
    case 'book:name': {
      if (!text) return tg.send(chatId, 'Напишите, пожалуйста, имя текстом.', { reply_markup: nameKeyboard(msg.from) });
      await db.saveSession(chatId, { step: 'book:phone', data: { ...session.data, name: text.slice(0, 60) } });
      return tg.send(chatId, 'Оставьте номер телефона — администратор подтвердит бронь. Можно нажать кнопку или написать номер.', {
        reply_markup: contactKeyboard,
      });
    }

    case 'book:phone': {
      const phone = (msg.contact ? msg.contact.phone_number : text).trim();
      if (!phone || !PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 7) {
        return tg.send(chatId, 'Похоже, номер введён неверно. Пример: +995 555 12 34 56', { reply_markup: contactKeyboard });
      }
      const booking = {
        id: newId(),
        chatId,
        eventId: session.data.eventId,
        people: session.data.people,
        name: session.data.name,
        phone,
        username: (msg.from && msg.from.username) || '',
        status: 'pending',
        reminded: false,
        createdAt: now.toISOString(),
      };
      let event = null;
      await db.mutate((d) => {
        event = aliveEvents(d, now).find((e) => e.id === booking.eventId) || null;
        if (!event) return false;
        d.bookings.push(booking);
      });
      await db.clearSession(chatId);
      if (!event) {
        return tg.send(chatId, 'Эта трансляция уже прошла или удалена. Выберите другую.', { reply_markup: menuFor(isAdmin) });
      }

      await tg.send(
        chatId,
        `📨 <b>Заявка отправлена!</b>\n\n${esc(event.title)} · ${formatEventTime(event.startsAt)}\nГостей: ${peopleLabel(booking.people)}\n\nКак только администратор подтвердит стол, вы получите сообщение. Перед началом пришлём напоминание.`,
        { reply_markup: menuFor(isAdmin) },
      );
      await notifyAdmins({ tg, adminIds: ctx.adminIds, text: bookingCard(booking, event), extra: { reply_markup: decisionButtons(booking.id) } });
      return;
    }

    // Админ: трансляция одним сообщением (название + дата/время, фото по желанию)
    case 'ev:quick': {
      if (!isAdmin) break;
      const input = (text || msg.caption || '').trim();
      if (!input) {
        if (photoId) {
          await db.saveSession(chatId, { step: 'ev:quick', data: { photo: photoId } });
          return tg.send(chatId, 'Афишу получил. Теперь напишите название и дату со временем, например: <b>Барселона — Реал, 01.11 21:00</b>', { reply_markup: cancelKeyboard });
        }
        return tg.send(chatId, 'Отправьте название и дату со временем одним сообщением.', { reply_markup: cancelKeyboard });
      }
      return quickEvent({ db, ctx, chatId, input, photo: photoId || (session.data && session.data.photo) || null });
    }

    // Админ: акция
    case 'pr:title': {
      if (!isAdmin) break;
      if (!text) return tg.send(chatId, 'Напишите название акции текстом.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'pr:text', data: { title: text.slice(0, 100) } });
      return tg.send(chatId, 'Текст акции (условия, что получает гость).', { reply_markup: cancelKeyboard });
    }
    case 'pr:text': {
      if (!isAdmin) break;
      if (!text) return tg.send(chatId, 'Напишите текст акции.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'pr:photo', data: { ...session.data, text: text.slice(0, 700) } });
      return tg.send(chatId, 'Фото к акции — или «Без фото».', { reply_markup: photoKeyboard });
    }
    case 'pr:photo': {
      if (!isAdmin) break;
      if (!photoId && text !== BTN.SKIP_PHOTO) return tg.send(chatId, 'Пришлите фото или нажмите «Без фото».', { reply_markup: photoKeyboard });
      await db.saveSession(chatId, { step: 'pr:kind', data: { ...session.data, photo: photoId } });
      await tg.send(chatId, photoId ? 'Фото получил 👍' : 'Без фото 👌', { reply_markup: cancelKeyboard });
      return tg.send(chatId, 'Как часто действует акция? Выберите день недели — бот будет напоминать о ней каждую неделю в этот день. Или «До даты».', {
        reply_markup: promoKindKeyboard(),
      });
    }
    case 'pr:kind':
      if (!isAdmin) break;
      return tg.send(chatId, 'Выберите день недели или «До даты» кнопкой выше ☝️');
    case 'pr:until': {
      if (!isAdmin) break;
      const until = parseLocalDate(text, now);
      if (!until) return tg.send(chatId, 'Формат даты: 31.12', { reply_markup: cancelKeyboard });
      if (new Date(until) < now) return tg.send(chatId, 'Эта дата уже прошла. Укажите будущую, например 31.12', { reply_markup: cancelKeyboard });
      return savePromo({ db, ctx, chatId, data: { ...session.data, kind: 'until', until } });
    }

    // Админ: рассылка
    case 'bc:content': {
      if (!isAdmin) break;
      const payload = photoId ? { photo: photoId, text: esc(msg.caption || '') } : { text: esc(text) };
      if (!payload.text && !payload.photo) return tg.send(chatId, 'Пришлите текст или фото с подписью.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'bc:confirm', data: { payload } });
      const users = Object.keys(await db.users()).length;
      return tg.send(chatId, `Отправить это сообщение всем гостям (${users})?`, {
        reply_markup: inline([[
          { text: '📢 Отправить', callback_data: 'bc:send' },
          { text: '✖️ Отмена', callback_data: 'bc:cancel' },
        ]]),
      });
    }
    case 'bc:confirm':
      if (!isAdmin) break;
      return tg.send(chatId, 'Нажмите «📢 Отправить» или «✖️ Отмена» выше ☝️');

    default:
      break;
  }
  await db.clearSession(chatId);
  return tg.send(chatId, 'Выберите действие в меню 👇', { reply_markup: menuFor(isAdmin) });
}

function nameKeyboard(from) {
  const rows = [];
  if (from && from.first_name) rows.push([{ text: from.first_name.slice(0, 40) }]);
  rows.push([{ text: BTN.CANCEL }]);
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: true };
}

function promoKindKeyboard() {
  const rows = [];
  for (let i = 0; i < WEEKDAY_BUTTONS.length; i += 4) {
    rows.push(WEEKDAY_BUTTONS.slice(i, i + 4).map(([n, label]) => ({ text: label, callback_data: `pw:${n}` })));
  }
  rows.push([{ text: '📅 До даты', callback_data: 'pu' }]);
  return inline(rows);
}

async function savePromo({ db, ctx, chatId, data }) {
  const { tg, now } = ctx;
  const promo = {
    id: newId(),
    title: data.title,
    text: data.text || '',
    photo: data.photo || null,
    kind: data.kind,
    weekday: data.weekday ?? null,
    until: data.until || null,
    lastRemindedDate: null,
    createdAt: now.toISOString(),
  };
  await db.mutate((d) => {
    d.promos.push(promo);
  });
  await db.clearSession(chatId);
  await tg.send(chatId, `✅ Акция «${esc(promo.title)}» добавлена (${promoWhen(promo)}) и появилась в разделе «Акции».`, {
    reply_markup: inline([[{ text: '📢 Анонсировать сейчас', callback_data: `pann:${promo.id}` }]]),
  });
  return tg.send(chatId, 'Готово 👌', { reply_markup: adminKeyboard });
}

// ---------- обработка нажатий на кнопки ----------

async function onCallback(q, ctx) {
  const { tg, env, now } = ctx;
  const db = makeDb(ctx.store, now);
  const chatId = q.message ? q.message.chat.id : q.from.id;
  const messageId = q.message ? q.message.message_id : null;
  const isPhoto = Boolean(q.message && q.message.photo); // у карточки с фото нельзя менять текст
  const isAdmin = ctx.isAdmin(chatId);
  const data = q.data || '';
  const [head, arg] = data.split(/:(.*)/s);

  await tg.answer(q.id);

  // Меню (без обращений к хранилищу)
  if (data === 'mn') return showMenuRoot({ tg, chatId, messageId, isPhoto });
  if (head === 'mc') return showMenuCategory({ tg, chatId, ci: arg === '' ? NaN : Number(arg), messageId, isPhoto });
  if (head === 'mi') {
    const [ci, ii] = String(arg).split('.').map(Number);
    return showMenuItem({ tg, chatId, ci, ii });
  }
  if (data === 'bkl') return startBooking({ tg, db, chatId, now });

  // Гостевые действия
  if (head === 'bk') {
    const events = await activeEvents(db, now, { fresh: false });
    const event = events.find((e) => e.id === arg);
    if (!event) return tg.send(chatId, 'Эта трансляция уже недоступна. Откройте «📅 Трансляции», чтобы увидеть актуальные.');
    await db.clearSession(chatId); // id трансляции едет в кнопках — запись в хранилище не нужна
    const btn = (n, text = String(n)) => ({ text, callback_data: `pp:${event.id}.${n}` });
    return tg.send(chatId, `Бронь: <b>${esc(event.title)}</b>\n🗓 ${formatEventTime(event.startsAt)}\n\nСколько будет гостей?`, {
      reply_markup: inline([[1, 2, 3].map((n) => btn(n)), [4, 5, 6].map((n) => btn(n)), [btn(7, '7 и больше')]]),
    });
  }

  if (head === 'pp') {
    const dot = String(arg).lastIndexOf('.');
    const eventId = dot > 0 ? arg.slice(0, dot) : null;
    const people = Math.min(7, Math.max(1, Number(dot > 0 ? arg.slice(dot + 1) : arg) || 1));
    if (!eventId) return tg.send(chatId, 'Начните бронь заново: кнопка «🏟 Забронировать стол».');
    await db.saveSession(chatId, { step: 'book:name', data: { eventId, people } });
    if (messageId) await tg.editText(chatId, messageId, `Гостей: <b>${peopleLabel(people)}</b> ✅`);
    return tg.send(chatId, 'Как к вам обращаться? Напишите имя или нажмите кнопку.', { reply_markup: nameKeyboard(q.from) });
  }

  // Ниже — только администратор
  if (!isAdmin) return;

  if (head === 'ok' || head === 'no') {
    let b = null;
    let e = null;
    let already = null;
    await db.mutate((d) => {
      b = d.bookings.find((x) => x.id === arg) || null;
      if (!b) return false;
      e = d.events.find((x) => x.id === b.eventId) || null;
      if (b.status !== 'pending') {
        already = b.status;
        return false;
      }
      b.status = head === 'ok' ? 'confirmed' : 'declined';
      b.decidedAt = now.toISOString();
    });
    if (!b) return tg.send(chatId, 'Заявка не найдена.');
    const verdict = (st) => (st === 'confirmed' ? '✅ Подтверждено' : '✖️ Отклонено');
    if (already) {
      if (messageId) await tg.editText(chatId, messageId, `${bookingCard(b, e)}\n\n<b>${verdict(already)}</b> (раньше)`);
      return;
    }
    const title = e ? `«${esc(e.title)}» · ${formatEventTime(e.startsAt)}` : 'трансляцию';
    if (head === 'ok') {
      await tg.send(b.chatId, `✅ <b>Стол забронирован!</b>\n${title}\nГостей: ${peopleLabel(b.people)}\n\nПеред началом пришлём напоминание. Ждём вас!\n📍 ${esc(VENUE.address)}`);
    } else {
      await tg.send(b.chatId, `К сожалению, не получилось подтвердить стол на ${title}. Позвоните нам: ${esc(VENUE.phone)} — или выберите другую трансляцию в меню.`);
    }
    if (messageId) await tg.editText(chatId, messageId, `${bookingCard(b, e)}\n\n<b>${verdict(b.status)}</b>`);
    return;
  }

  if (head === 'adm') {
    if (arg === 'ev') {
      await db.saveSession(chatId, { step: 'ev:quick', data: {} });
      return tg.send(chatId, EVENT_PROMPT, { reply_markup: cancelKeyboard });
    }
    if (arg === 'pr') {
      await db.saveSession(chatId, { step: 'pr:title', data: {} });
      return tg.send(chatId, 'Название акции, например: «2+1 по средам».', { reply_markup: cancelKeyboard });
    }
    if (arg === 'bk') return listBookings({ tg, db, chatId });
    if (arg === 'sc') return listSchedule({ tg, db, chatId, now });
    if (arg === 'bc') {
      await db.saveSession(chatId, { step: 'bc:content', data: {} });
      return tg.send(chatId, 'Пришлите текст рассылки или фото с подписью — отправим всем гостям, которые запускали бота.', { reply_markup: cancelKeyboard });
    }
    return;
  }

  if (head === 'pw' || head === 'pu') {
    const session = await db.session(chatId);
    if (!session || session.step !== 'pr:kind') return tg.send(chatId, 'Начните добавление акции заново.');
    if (head === 'pu') {
      await db.saveSession(chatId, { step: 'pr:until', data: session.data });
      return tg.send(chatId, 'До какой даты действует акция? Формат: 31.12', { reply_markup: cancelKeyboard });
    }
    const weekday = Number(arg);
    if (!(weekday >= 0 && weekday <= 6)) return;
    return savePromo({ db, ctx, chatId, data: { ...session.data, kind: 'weekly', weekday } });
  }

  if (head === 'ann') {
    const e = (await db.data()).events.find((x) => x.id === arg);
    if (!e) return tg.send(chatId, 'Трансляция уже удалена.');
    if (messageId) await tg.call?.('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: inline([]) });
    const sent = await broadcast({
      tg,
      db,
      payload: {
        photo: e.photo || (env.PUBLIC_URL ? `${env.PUBLIC_URL}/img/cover.jpg` : null),
        text: `🔥 <b>${esc(e.title)}</b>\n🗓 ${formatEventTime(e.startsAt)}\n\nЗабронируйте стол по кнопке ниже 👇`,
        extra: { reply_markup: inline([[{ text: '🏟 Забронировать стол', callback_data: `bk:${e.id}` }]]) },
      },
    });
    return tg.send(chatId, `📢 Анонс отправлен: ${sent} гостям.`);
  }

  if (head === 'pann') {
    const p = (await db.data()).promos.find((x) => x.id === arg);
    if (!p) return tg.send(chatId, 'Акция уже удалена.');
    if (messageId) await tg.call?.('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: inline([]) });
    const sent = await broadcast({ tg, db, payload: { photo: p.photo, text: promoCaption(p), extra: {} } });
    return tg.send(chatId, `📢 Акция отправлена: ${sent} гостям.`);
  }

  if (head === 'dl' || head === 'dp') {
    let removed = null;
    await db.mutate((d) => {
      const list = head === 'dl' ? d.events : d.promos;
      const i = list.findIndex((x) => x.id === arg);
      if (i < 0) return false;
      removed = list.splice(i, 1)[0];
    });
    const what = head === 'dl' ? 'Трансляция' : 'Акция';
    if (!removed) return tg.send(chatId, `${what} уже удалена.`);
    if (messageId) {
      const edited = await tg.editText(chatId, messageId, `🗑 ${what} «${esc(removed.title)}» удалена.`);
      if (edited) return;
    }
    return tg.send(chatId, `🗑 ${what} «${esc(removed.title)}» удалена.`);
  }

  if (data === 'bc:send') {
    const session = await db.session(chatId);
    if (!session || session.step !== 'bc:confirm') return tg.send(chatId, 'Рассылка уже отправлена или отменена.');
    await db.clearSession(chatId);
    if (messageId) await tg.editText(chatId, messageId, '📢 Отправляю…');
    const sent = await broadcast({ tg, db, payload: { ...session.data.payload, extra: {} } });
    return tg.send(chatId, `📢 Рассылка отправлена: ${sent} гостям.`, { reply_markup: adminKeyboard });
  }

  if (data === 'bc:cancel') {
    await db.clearSession(chatId);
    if (messageId) await tg.editText(chatId, messageId, 'Рассылка отменена.');
    return tg.send(chatId, 'Хорошо, ничего не отправляю.', { reply_markup: adminKeyboard });
  }
}

// ---------- точка входа ----------

export async function handleUpdate(update, ctx) {
  const envIds = ((ctx.env && ctx.env.ADMIN_CHAT_IDS) || '').split(',').map((v) => v.trim()).filter(Boolean);
  // Список админов меняется редко — читаем из тёплого кэша (до 5 минут), чтобы не тратить лимит хранилища
  const stored = (await ctx.store.getCached('admins', [], 5 * 60e3)).map(String);
  const adminIds = [...new Set([...envIds, ...stored])];
  const context = {
    ...ctx,
    now: ctx.now || new Date(),
    adminIds,
    isAdmin: (id) => adminIds.includes(String(id)),
  };
  if (update.callback_query) return onCallback(update.callback_query, context);
  if (update.message) return onMessage(update.message, context);
}

// ---------- напоминания (вызывается по расписанию) ----------

export async function runReminders(ctx) {
  const { tg, store } = ctx;
  const now = ctx.now || new Date();
  const db = makeDb(store, now);
  const report = { bookingReminders: 0, weeklyPromos: 0, cleaned: 0 };

  const d = await db.data(); // одно чтение хранилища на запуск
  const today = localDateKey(now);
  const cutoff = eventCutoff(now);

  const due = d.bookings.filter((b) => {
    if (b.status !== 'confirmed' || b.reminded) return false;
    const e = d.events.find((x) => x.id === b.eventId);
    if (!e) return false;
    const diff = new Date(e.startsAt).getTime() - now.getTime();
    return diff > 0 && diff <= BOOKING_REMINDER_MINUTES * 60e3;
  });
  const promosDue = d.promos.filter(
    (p) => p.kind === 'weekly' && localWeekday(now) === p.weekday && localHour(now) >= WEEKLY_REMINDER_HOUR && p.lastRemindedDate !== today,
  );
  const stale = d.events.filter((e) => new Date(e.startsAt).getTime() <= cutoff);
  const expiredPromos = d.promos.filter((p) => p.kind !== 'weekly' && new Date(p.until) < now);

  if (!due.length && !promosDue.length && !stale.length && !expiredPromos.length) return report; // ничего не пишем

  // Сначала помечаем в хранилище (атомарно), потом отправляем — так двойной запуск не продублирует напоминания
  const dueIds = new Set(due.map((b) => b.id));
  const promoIds = new Set(promosDue.map((p) => p.id));
  let claimed = { bookings: [], promos: [] };
  await db.mutate((cur) => {
    claimed = { bookings: [], promos: [] };
    for (const b of cur.bookings) {
      if (dueIds.has(b.id) && !b.reminded) {
        b.reminded = true;
        claimed.bookings.push(b);
      }
    }
    for (const p of cur.promos) {
      if (promoIds.has(p.id) && p.lastRemindedDate !== today) {
        p.lastRemindedDate = today;
        claimed.promos.push(p);
      }
    }
    const before = cur.events.length;
    const aliveIds = new Set(cur.events.filter((e) => new Date(e.startsAt).getTime() > cutoff).map((e) => e.id));
    cur.events = cur.events.filter((e) => aliveIds.has(e.id));
    report.cleaned = before - cur.events.length;
    cur.promos = cur.promos.filter((p) => p.kind === 'weekly' || new Date(p.until) >= now);
    // Старые заявки (по удалённым трансляциям старше 30 дней) не храним вечно
    const monthAgo = now.getTime() - 30 * 86400e3;
    cur.bookings = cur.bookings.filter((b) => aliveIds.has(b.eventId) || new Date(b.createdAt).getTime() > monthAgo);
  });

  for (const b of claimed.bookings) {
    const e = d.events.find((x) => x.id === b.eventId);
    if (!e) continue;
    await tg.send(
      b.chatId,
      `⏰ <b>Напоминание о брони</b>\n\n${esc(e.title)} — начало в ${formatEventTime(e.startsAt).split(' ').pop()}.\nВаш стол ждёт вас (гостей: ${peopleLabel(b.people)}). До встречи в ${esc(VENUE.name)}!\n📍 ${esc(VENUE.address)}`,
    );
    report.bookingReminders++;
  }
  for (const p of claimed.promos) {
    report.weeklyPromos += await broadcast({ tg, db, payload: { photo: p.photo, text: `🔔 <b>Сегодня акция!</b>\n\n${promoCaption(p)}`, extra: {} } });
  }
  return report;
}
