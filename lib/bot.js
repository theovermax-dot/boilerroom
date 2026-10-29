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

function makeDb(store) {
  return {
    events: () => store.get('events', []),
    saveEvents: (v) => store.set('events', v),
    bookings: () => store.get('bookings', []),
    saveBookings: (v) => store.set('bookings', v),
    promos: () => store.get('promos', []),
    savePromos: (v) => store.set('promos', v),
    users: () => store.get('users', {}),
    saveUsers: (v) => store.set('users', v),
    session: (chatId) => store.get(`s:${chatId}`, null),
    saveSession: (chatId, v) => store.set(`s:${chatId}`, v),
    clearSession: (chatId) => store.del(`s:${chatId}`),
  };
}

async function touchUser(db, chatId, from, now) {
  const users = await db.users();
  const prev = users[chatId] || {};
  users[chatId] = {
    name: from.first_name || prev.name || '',
    username: from.username || prev.username || '',
    seenAt: now.toISOString(),
  };
  await db.saveUsers(users);
}

async function activeEvents(db, now) {
  const cutoff = now.getTime() - EVENT_GRACE_HOURS * 3600e3;
  return (await db.events())
    .filter((e) => new Date(e.startsAt).getTime() > cutoff)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

async function activePromos(db, now) {
  return (await db.promos()).filter((p) => p.kind === 'weekly' || new Date(p.until) >= now);
}

function eventCaption(e) {
  return `<b>${esc(e.title)}</b>\n🗓 ${formatEventTime(e.startsAt)}\n\nБронь стола — по кнопке ниже 👇`;
}

function promoCaption(p) {
  const when = p.kind === 'weekly' ? `каждый(ую) ${weekdayName(p.weekday)}` : `до ${new Date(p.until).toISOString().slice(0, 10).split('-').reverse().join('.')}`;
  return `<b>${esc(p.title)}</b>\n${esc(p.text || '')}\n\n🗓 ${when}`;
}

function menuFor(isAdmin) {
  return isAdmin ? adminKeyboard : guestKeyboard;
}

// ---------- гостевые сценарии ----------

async function sendWelcome({ tg, env, chatId, isAdmin }) {
  const welcomeText =
    `<b>${esc(VENUE.name)} ${esc(VENUE.city)}</b>\n\n` +
    `Здесь можно забронировать стол на футбол, UFC и бокс — без звонков, а ещё посмотреть меню с ценами и фото.\n\n` +
    `Выберите действие в меню 👇`;
  if (env.PUBLIC_URL) {
    await tg.photo(chatId, `${env.PUBLIC_URL}/img/welcome.jpg`, welcomeText, { reply_markup: menuFor(isAdmin) });
  } else {
    await tg.send(chatId, welcomeText, { reply_markup: menuFor(isAdmin) });
  }
}

async function showEvents({ tg, db, env, chatId, now }) {
  const events = (await activeEvents(db, now)).slice(0, 6);
  if (!events.length) {
    return tg.send(chatId, 'Ближайших трансляций пока нет. Загляните позже — мы обязательно добавим матчи 🙌');
  }
  for (const e of events) {
    const photo = e.photo || (env.PUBLIC_URL ? `${env.PUBLIC_URL}/img/cover.jpg` : null);
    const extra = { reply_markup: inline([[{ text: '🏟 Забронировать стол', callback_data: `bk:${e.id}` }]]) };
    if (photo) await tg.photo(chatId, photo, eventCaption(e), extra);
    else await tg.send(chatId, eventCaption(e), extra);
  }
}

async function showPromos({ tg, db, env, chatId, now }) {
  const promos = await activePromos(db, now);
  if (!promos.length) {
    return tg.send(chatId, 'Сейчас активных акций нет. Следите за обновлениями!');
  }
  for (const p of promos) {
    if (p.photo) await tg.photo(chatId, p.photo, promoCaption(p));
    else await tg.send(chatId, promoCaption(p));
  }
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
  const events = await activeEvents(db, now);
  if (!events.length) {
    return tg.send(chatId, 'Ближайших трансляций пока нет. Загляните позже — мы обязательно добавим матчи 🙌');
  }
  const rows = events.map((e) => [{ text: `${formatEventTime(e.startsAt)} · ${e.title}`, callback_data: `bk:${e.id}` }]);
  return tg.send(chatId, 'Выберите трансляцию для брони 👇', { reply_markup: inline(rows) });
}

// ---------- меню ----------

const money = (n) => `${n} ${CURRENCY}`;

function menuRootKeyboard() {
  const rows = [];
  for (let i = 0; i < MENU.length; i += 2) {
    rows.push(
      MENU.slice(i, i + 2).map((c, j) => ({ text: `${c.emoji} ${c.title}`, callback_data: `mc:${i + j}` })),
    );
  }
  rows.push([{ text: '🏟 Забронировать стол', callback_data: 'bkl' }]);
  return inline(rows);
}

const MENU_ROOT_TEXT =
  `🍽 <b>Меню ${esc(VENUE.name)}</b>\n\nВыберите раздел. Цены в лари (${CURRENCY}), по каждой позиции есть фото.`;

async function showMenuRoot({ tg, chatId, messageId = null }) {
  if (messageId) {
    const edited = await tg.editText(chatId, messageId, MENU_ROOT_TEXT, { reply_markup: menuRootKeyboard() });
    if (edited) return edited;
    // Это была карточка с фото: текст не отредактировать, шлём меню новым сообщением и убираем карточку
    const sent = await tg.send(chatId, MENU_ROOT_TEXT, { reply_markup: menuRootKeyboard() });
    if (sent && tg.call) await tg.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    return sent;
  }
  return tg.send(chatId, MENU_ROOT_TEXT, { reply_markup: menuRootKeyboard() });
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

async function showMenuCategory({ tg, chatId, ci, messageId = null }) {
  if (!MENU[ci]) return showMenuRoot({ tg, chatId });
  const { text, markup } = categoryView(ci);
  if (messageId) {
    const edited = await tg.editText(chatId, messageId, text, { reply_markup: markup });
    if (edited) return edited;
  }
  const sent = await tg.send(chatId, text, { reply_markup: markup });
  if (sent && messageId && tg.call) await tg.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  return sent;
}

async function showMenuItem({ tg, chatId, ci, ii }) {
  const cat = MENU[ci];
  const item = cat && cat.items[ii];
  if (!item) return showMenuRoot({ tg, chatId });
  const [name, price, portion, img] = item;
  const caption = `<b>${esc(name)}</b>\n${money(price)}${portion ? ` · ${esc(portion)}` : ''}`;
  const markup = inline([
    [{ text: `⬅️ ${cat.title}`, callback_data: `mc:${ci}` }, { text: '🍽 Меню', callback_data: 'mn' }],
    [{ text: '🏟 Забронировать стол', callback_data: 'bkl' }],
  ]);
  const sent = await tg.photo(chatId, `${IMG_BASE}${img}`, caption, { reply_markup: markup });
  // Если фото не загрузилось, показываем карточку текстом
  if (!sent) await tg.send(chatId, caption, { reply_markup: markup });
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

async function broadcast({ tg, db, payload }) {
  const users = Object.keys(await db.users());
  let sent = 0;
  // Пачками, чтобы не упереться в лимиты Telegram и таймаут функции
  for (let i = 0; i < users.length; i += 20) {
    const chunk = users.slice(i, i + 20);
    await Promise.all(
      chunk.map((id) => {
        if (payload.photo) return tg.photo(id, payload.photo, payload.text, payload.extra || {});
        return tg.send(id, payload.text, payload.extra || {});
      }),
    );
    sent += chunk.length;
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
    `Гостей: ${b.people === 7 ? '7 и больше' : b.people}\n` +
    `Имя: ${esc(b.name)}\n` +
    `Телефон: ${esc(b.phone)}` +
    (b.username ? `\nTelegram: @${esc(b.username)}` : '')
  );
}

async function listBookings({ tg, db, chatId }) {
  const pending = (await db.bookings()).filter((b) => b.status === 'pending');
  if (!pending.length) return tg.send(chatId, 'Новых заявок нет ✅');
  const events = await db.events();
  for (const b of pending) {
    const e = events.find((x) => x.id === b.eventId);
    await tg.send(chatId, bookingCard(b, e), {
      reply_markup: inline([[
        { text: '✅ Подтвердить', callback_data: `ok:${b.id}` },
        { text: '✖️ Отклонить', callback_data: `no:${b.id}` },
      ]]),
    });
  }
}

async function listSchedule({ tg, db, chatId, now }) {
  const events = await activeEvents(db, now);
  const promos = await activePromos(db, now);
  if (!events.length && !promos.length) return tg.send(chatId, 'Расписание пустое. Добавьте трансляцию или акцию.');
  for (const e of events) {
    await tg.send(chatId, `🏟 <b>${esc(e.title)}</b>\n${formatEventTime(e.startsAt)}`, {
      reply_markup: inline([[
        { text: '📢 Анонсировать', callback_data: `ann:${e.id}` },
        { text: '🗑 Удалить', callback_data: `dl:${e.id}` },
      ]]),
    });
  }
  for (const p of promos) {
    await tg.send(chatId, `🎁 <b>${esc(p.title)}</b>\n${p.kind === 'weekly' ? `каждый(ую) ${weekdayName(p.weekday)}` : 'разовая / до даты'}`, {
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
async function quickEvent({ db, ctx, chatId, input, photo, isAdmin, silent = false }) {
  const { tg, now } = ctx;
  const parsed = extractDateTime(input, now);
  const error = parsed.error || (!parsed.title ? 'notitle' : null);
  if (error) {
    if (!silent) await tg.send(chatId, DATE_ERRORS[error], { reply_markup: cancelKeyboard });
    return false;
  }
  const events = await db.events();
  const event = { id: newId(), title: parsed.title, startsAt: parsed.startsAt, photo: photo || null, createdAt: now.toISOString() };
  events.push(event);
  await db.saveEvents(events);
  await db.clearSession(chatId);
  await tg.send(
    chatId,
    `✅ Трансляция добавлена: <b>${esc(event.title)}</b>\n🗓 ${formatEventTime(event.startsAt)}${event.photo ? '\n🖼 с афишей' : ''}\n\nГости уже видят её и могут бронировать стол.`,
    {
      reply_markup: inline([
        [{ text: '📢 Анонсировать всем', callback_data: `ann:${event.id}` }],
        [{ text: '➕ Добавить ещё', callback_data: 'adm:ev' }],
      ]),
    },
  );
  return true;
}

const WEEKDAY_BUTTONS = [
  [1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс'],
];

// ---------- маршрутизация сообщений ----------

async function onMessage(msg, ctx) {
  const { tg, env, now } = ctx;
  const db = makeDb(ctx.store);
  const chatId = msg.chat.id;
  const isAdmin = ctx.isAdmin(chatId);
  const text = (msg.text || '').trim();

  await touchUser(db, chatId, msg.from || {}, now);

  // Первый вход админа: /admin <ADMIN_CODE>. Код знает только владелец.
  if (/^\/admin\s+\S+/.test(text) && env.ADMIN_CODE) {
    if (tg.call) await tg.call('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    if (text.split(/\s+/)[1] === env.ADMIN_CODE) {
      const stored = await ctx.store.get('admins', []);
      if (!stored.map(String).includes(String(chatId))) {
        stored.push(chatId);
        await ctx.store.set('admins', stored);
      }
      await db.clearSession(chatId);
      return tg.send(chatId, '✅ Вы подключены как администратор. Откройте «⚙️ Админ-панель».', { reply_markup: adminKeyboard });
    }
    return tg.send(chatId, 'Неверный код.', { reply_markup: menuFor(isAdmin) });
  }

  // Команды и кнопки меню всегда сбрасывают незавершённый сценарий
  const menuActions = {
    '/start': async () => { await db.clearSession(chatId); return sendWelcome({ tg, env, chatId, isAdmin }); },
    '/cancel': async () => { await db.clearSession(chatId); return tg.send(chatId, 'Отменено.', { reply_markup: menuFor(isAdmin) }); },
    [BTN.CANCEL]: async () => { await db.clearSession(chatId); return tg.send(chatId, 'Отменено.', { reply_markup: menuFor(isAdmin) }); },
    '/book': () => startBooking({ tg, db, chatId, now }),
    [BTN.BOOK]: () => startBooking({ tg, db, chatId, now }),
    [BTN.EVENTS]: () => showEvents({ tg, db, env, chatId, now }),
    [BTN.PROMOS]: () => showPromos({ tg, db, env, chatId, now }),
    [BTN.MENU]: () => showMenuRoot({ tg, chatId }),
    [BTN.INFO]: () => showInfo({ tg, chatId }),
    '/menu': () => showMenuRoot({ tg, chatId }),
  };
  if (isAdmin) {
    menuActions['/admin'] = async () => { await db.clearSession(chatId); return tg.send(chatId, 'Админ-панель', { reply_markup: adminPanel() }); };
    menuActions[BTN.ADMIN] = menuActions['/admin'];
  }

  if (menuActions[text]) {
    if (!['/cancel', BTN.CANCEL].includes(text) && !text.startsWith('/')) await db.clearSession(chatId);
    return menuActions[text]();
  }

  const session = await db.session(chatId);
  if (session && session.step) {
    return handleStep({ msg, text, session, db, ctx, chatId, isAdmin });
  }

  // Быстрый путь для админа: сообщение вида «Барселона — Реал 01.11 21:00» (можно с фото) сразу создаёт трансляцию
  if (isAdmin) {
    const input = (text || msg.caption || '').trim();
    const photo = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
    if (input && (await quickEvent({ db, ctx, chatId, input, photo, isAdmin, silent: true }))) return;
  }

  return tg.send(chatId, 'Выберите действие в меню 👇', { reply_markup: menuFor(isAdmin) });
}

// ---------- пошаговые сценарии ----------

async function handleStep({ msg, text, session, db, ctx, chatId, isAdmin }) {
  const { tg, env, now } = ctx;
  const photoId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;

  switch (session.step) {
    // Гость: имя → телефон → заявка
    case 'book:name': {
      if (!text) return tg.send(chatId, 'Напишите, пожалуйста, имя текстом.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'book:phone', data: { ...session.data, name: text.slice(0, 60) } });
      return tg.send(chatId, 'Оставьте номер телефона — администратор подтвердит бронь. Можно нажать кнопку или написать номер.', {
        reply_markup: contactKeyboard,
      });
    }

    case 'book:phone': {
      const phone = msg.contact ? msg.contact.phone_number : text;
      if (!phone || !PHONE_RE.test(phone)) {
        return tg.send(chatId, 'Похоже, номер введён неверно. Пример: +995 555 12 34 56', { reply_markup: contactKeyboard });
      }
      const events = await db.events();
      const event = events.find((e) => e.id === session.data.eventId);
      if (!event || new Date(event.startsAt) < now) {
        await db.clearSession(chatId);
        return tg.send(chatId, 'Эта трансляция уже прошла или удалена. Выберите другую.', { reply_markup: menuFor(isAdmin) });
      }
      const booking = {
        id: newId(),
        chatId,
        eventId: event.id,
        people: session.data.people,
        name: session.data.name,
        phone,
        username: (msg.from && msg.from.username) || '',
        status: 'pending',
        reminded: false,
        createdAt: now.toISOString(),
      };
      const bookings = await db.bookings();
      bookings.push(booking);
      await db.saveBookings(bookings);
      await db.clearSession(chatId);

      await tg.send(
        chatId,
        `📨 <b>Заявка отправлена!</b>\n\n${esc(event.title)} · ${formatEventTime(event.startsAt)}\nГостей: ${booking.people === 7 ? '7 и больше' : booking.people}\n\nКак только администратор подтвердит стол, вы получите сообщение. За ${BOOKING_REMINDER_MINUTES} минут до начала придёт напоминание.`,
        { reply_markup: menuFor(isAdmin) },
      );
      await notifyAdmins({
        tg,
        adminIds: ctx.adminIds,
        text: bookingCard(booking, event),
        extra: {
          reply_markup: inline([[
            { text: '✅ Подтвердить', callback_data: `ok:${booking.id}` },
            { text: '✖️ Отклонить', callback_data: `no:${booking.id}` },
          ]]),
        },
      });
      return;
    }

    // Админ: трансляция одним сообщением (название + дата/время, фото по желанию)
    case 'ev:quick': {
      const input = (text || msg.caption || '').trim();
      if (!input) {
        if (photoId) {
          await db.saveSession(chatId, { step: 'ev:quick', data: { photo: photoId } });
          return tg.send(chatId, 'Афишу получил. Теперь напишите название и дату со временем, например: <b>Барселона — Реал, 01.11 21:00</b>', { reply_markup: cancelKeyboard });
        }
        return tg.send(chatId, 'Отправьте название и дату со временем одним сообщением.', { reply_markup: cancelKeyboard });
      }
      return quickEvent({ db, ctx, chatId, input, photo: photoId || (session.data && session.data.photo) || null, isAdmin });
    }

    // Админ: акция
    case 'pr:title': {
      if (!text) return tg.send(chatId, 'Напишите название акции текстом.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'pr:text', data: { title: text.slice(0, 100) } });
      return tg.send(chatId, 'Текст акции (условия, что получает гость).', { reply_markup: cancelKeyboard });
    }
    case 'pr:text': {
      if (!text) return tg.send(chatId, 'Напишите текст акции.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'pr:photo', data: { ...session.data, text: text.slice(0, 500) } });
      return tg.send(chatId, 'Фото к акции — или «Без фото».', { reply_markup: photoKeyboard });
    }
    case 'pr:photo': {
      if (!photoId && text !== BTN.SKIP_PHOTO) return tg.send(chatId, 'Пришлите фото или нажмите «Без фото».', { reply_markup: photoKeyboard });
      await db.saveSession(chatId, { step: 'pr:kind', data: { ...session.data, photo: photoId } });
      return tg.send(chatId, 'Как часто действует акция? Выберите день недели — бот будет напоминать об акции каждую неделю в этот день. Или «До даты».', {
        reply_markup: promoKindKeyboard(),
      });
    }
    case 'pr:until': {
      const until = parseLocalDate(text, now);
      if (!until) return tg.send(chatId, 'Формат даты: 31.12', { reply_markup: cancelKeyboard });
      return savePromo({ db, ctx, chatId, data: { ...session.data, kind: 'until', until } });
    }

    // Админ: рассылка
    case 'bc:content': {
      const payload = photoId
        ? { photo: photoId, text: msg.caption || '' }
        : { text };
      if (!payload.text && !payload.photo) return tg.send(chatId, 'Пришлите текст или фото с подписью.', { reply_markup: cancelKeyboard });
      await db.saveSession(chatId, { step: 'bc:confirm', data: { payload } });
      return tg.send(chatId, 'Отправить это сообщение всем гостям?', {
        reply_markup: inline([[
          { text: '📢 Отправить', callback_data: 'bc:send' },
          { text: '✖️ Отмена', callback_data: 'bc:cancel' },
        ]]),
      });
    }

    default:
      await db.clearSession(chatId);
      return tg.send(chatId, 'Выберите действие в меню 👇', { reply_markup: menuFor(isAdmin) });
  }
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
  const promos = await db.promos();
  promos.push(promo);
  await db.savePromos(promos);
  await db.clearSession(chatId);
  return tg.send(chatId, `✅ Акция «${esc(promo.title)}» добавлена и появится в меню «Акции».`, {
    reply_markup: inline([[{ text: '📢 Анонсировать сейчас', callback_data: `pann:${promo.id}` }]]),
  });
}

// ---------- обработка нажатий на кнопки ----------

async function onCallback(q, ctx) {
  const { tg, env, now } = ctx;
  const db = makeDb(ctx.store);
  const chatId = q.message ? q.message.chat.id : q.from.id;
  const messageId = q.message ? q.message.message_id : null;
  const isAdmin = ctx.isAdmin(chatId);
  const data = q.data || '';
  const [head, arg] = data.split(/:(.*)/s);

  await tg.answer(q.id);

  // Меню
  if (data === 'mn') return showMenuRoot({ tg, chatId, messageId });
  if (head === 'mc') return showMenuCategory({ tg, chatId, ci: Number(arg), messageId });
  if (head === 'mi') {
    const [ci, ii] = String(arg).split('.').map(Number);
    return showMenuItem({ tg, chatId, ci, ii });
  }
  if (data === 'bkl') return startBooking({ tg, db, chatId, now });

  // Гостевые действия
  if (head === 'bk') {
    const events = await activeEvents(db, now);
    const event = events.find((e) => e.id === arg);
    if (!event) return tg.send(chatId, 'Эта трансляция уже недоступна.');
    await db.saveSession(chatId, { step: 'book:people', data: { eventId: event.id } });
    return tg.send(chatId, `Бронь: <b>${esc(event.title)}</b>\nСколько гостей?`, {
      reply_markup: inline([
        [1, 2, 3].map((n) => ({ text: String(n), callback_data: `pp:${n}` })),
        [4, 5, 6].map((n) => ({ text: String(n), callback_data: `pp:${n}` })),
        [{ text: '7 и больше', callback_data: 'pp:7' }],
      ]),
    });
  }

  if (head === 'pp') {
    const session = await db.session(chatId);
    if (!session || session.step !== 'book:people') return tg.send(chatId, 'Начните бронь заново: кнопка «🏟 Забронировать стол».');
    await db.saveSession(chatId, { step: 'book:name', data: { ...session.data, people: Number(arg) } });
    return tg.send(chatId, 'Как к вам обращаться? Напишите имя.', { reply_markup: cancelKeyboard });
  }

  // Ниже — только администратор
  if (!isAdmin) return;

  if (head === 'ok' || head === 'no') {
    const bookings = await db.bookings();
    const b = bookings.find((x) => x.id === arg);
    if (!b) return tg.send(chatId, 'Заявка не найдена.');
    if (b.status !== 'pending') return tg.send(chatId, `Заявка уже обработана: ${b.status === 'confirmed' ? 'подтверждена' : 'отклонена'}.`);
    const events = await db.events();
    const e = events.find((x) => x.id === b.eventId);
    b.status = head === 'ok' ? 'confirmed' : 'declined';
    await db.saveBookings(bookings);
    const title = e ? `«${esc(e.title)}» · ${formatEventTime(e.startsAt)}` : 'трансляция';
    if (head === 'ok') {
      await tg.send(b.chatId, `✅ <b>Стол забронирован!</b>\n${title}\nГостей: ${b.people === 7 ? '7 и больше' : b.people}\n\nЗа ${BOOKING_REMINDER_MINUTES} минут до начала пришлём напоминание. Ждём вас!`);
    } else {
      await tg.send(b.chatId, `К сожалению, не получилось подтвердить стол на ${title}. Напишите нам или выберите другое время в меню.`);
    }
    if (messageId) {
      await tg.editText(chatId, messageId, `${bookingCard(b, e)}\n\n<b>${head === 'ok' ? '✅ Подтверждено' : '✖️ Отклонено'}</b>`);
    }
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
      return tg.send(chatId, 'Пришлите текст рассылки или фото с подписью — отправим всем гостям, которые писали боту.', { reply_markup: cancelKeyboard });
    }
  }

  if (head === 'pw' || head === 'pu') {
    const session = await db.session(chatId);
    if (!session || session.step !== 'pr:kind') return tg.send(chatId, 'Начните добавление акции заново.');
    if (head === 'pu') {
      await db.saveSession(chatId, { step: 'pr:until', data: session.data });
      return tg.send(chatId, 'До какой даты действует акция? Формат: 31.12', { reply_markup: cancelKeyboard });
    }
    return savePromo({
      db,
      ctx,
      chatId,
      data: { ...session.data, kind: 'weekly', weekday: Number(arg) },
    });
  }

  if (head === 'ann') {
    const e = (await db.events()).find((x) => x.id === arg);
    if (!e) return tg.send(chatId, 'Трансляция уже удалена.');
    const sent = await broadcast({
      tg,
      db,
      payload: {
        photo: e.photo || (env.PUBLIC_URL ? `${env.PUBLIC_URL}/img/cover.jpg` : null),
        text: `🔥 <b>${esc(e.title)}</b>\n🗓 ${formatEventTime(e.startsAt)}\n\nЗабронируйте стол в боте — кнопка «${BTN.BOOK}»`,
        extra: {},
      },
    });
    return tg.send(chatId, `📢 Анонс отправлен: ${sent} гостям.`);
  }

  if (head === 'pann') {
    const p = (await db.promos()).find((x) => x.id === arg);
    if (!p) return tg.send(chatId, 'Акция уже удалена.');
    const sent = await broadcast({ tg, db, payload: { photo: p.photo, text: promoCaption(p), extra: {} } });
    return tg.send(chatId, `📢 Акция отправлена: ${sent} гостям.`);
  }

  if (head === 'dl') {
    const events = (await db.events()).filter((x) => x.id !== arg);
    await db.saveEvents(events);
    return tg.send(chatId, 'Трансляция удалена из расписания.');
  }

  if (head === 'dp') {
    const promos = (await db.promos()).filter((x) => x.id !== arg);
    await db.savePromos(promos);
    return tg.send(chatId, 'Акция удалена.');
  }

  if (data === 'bc:send') {
    const session = await db.session(chatId);
    if (!session || session.step !== 'bc:confirm') return tg.send(chatId, 'Рассылка уже отправлена или отменена.');
    await db.clearSession(chatId);
    const sent = await broadcast({ tg, db, payload: { ...session.data.payload, extra: {} } });
    return tg.send(chatId, `📢 Рассылка отправлена: ${sent} гостям.`);
  }

  if (data === 'bc:cancel') {
    await db.clearSession(chatId);
    return tg.send(chatId, 'Рассылка отменена.');
  }
}

// ---------- точка входа ----------

export async function handleUpdate(update, ctx) {
  const envIds = ((ctx.env && ctx.env.ADMIN_CHAT_IDS) || '').split(',').map((v) => v.trim()).filter(Boolean);
  const stored = (await ctx.store.get('admins', [])).map(String);
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
  const { tg, store, env } = ctx;
  const now = ctx.now || new Date();
  const db = makeDb(store);
  const report = { bookingReminders: 0, weeklyPromos: 0, cleaned: 0 };

  // 1. Убираем прошедшие трансляции
  const cutoff = now.getTime() - EVENT_GRACE_HOURS * 3600e3;
  const events = await db.events();
  const alive = events.filter((e) => new Date(e.startsAt).getTime() > cutoff);
  report.cleaned = events.length - alive.length;
  if (report.cleaned) await db.saveEvents(alive);

  // 2. Напоминания о брони за час до начала
  const bookings = await db.bookings();
  let changed = false;
  for (const b of bookings) {
    if (b.status !== 'confirmed' || b.reminded) continue;
    const e = alive.find((x) => x.id === b.eventId);
    if (!e) continue;
    const diff = new Date(e.startsAt).getTime() - now.getTime();
    if (diff > 0 && diff <= BOOKING_REMINDER_MINUTES * 60e3) {
      await tg.send(b.chatId, `⏰ <b>Через час начинается:</b> ${esc(e.title)}\nВаш стол на ${b.people === 7 ? '7 и больше' : b.people} гостей ждёт вас. До встречи в ${esc(VENUE.name)}!`);
      b.reminded = true;
      report.bookingReminders++;
      changed = true;
    }
  }
  if (changed) await db.saveBookings(bookings);

  // 3. Еженедельные акции (например, «2+1 по средам»)
  const promos = await db.promos();
  let promosChanged = false;
  const today = localDateKey(now);
  for (const p of promos) {
    if (p.kind !== 'weekly') continue;
    if (localWeekday(now) !== p.weekday || localHour(now) < WEEKLY_REMINDER_HOUR) continue;
    if (p.lastRemindedDate === today) continue;
    report.weeklyPromos += await broadcast({ tg, db, payload: { photo: p.photo, text: `🔔 <b>Сегодня!</b>\n\n${promoCaption(p)}`, extra: {} } });
    p.lastRemindedDate = today;
    promosChanged = true;
  }
  if (promosChanged) await db.savePromos(promos);

  return report;
}
