import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, runReminders } from '../lib/bot.js';
import { parseLocalDateTime, extractDateTime } from '../lib/time.js';
import { createStore } from '../lib/store.js';
import { MENU } from '../lib/menu.js';

// ---------- имитация Telegram ----------
// Ведёт журнал исходящих сообщений и ведёт себя как настоящий API там, где это важно:
// текст сообщения с фото отредактировать нельзя, у неработающей картинки sendPhoto возвращает null.
function fakeTg({ brokenPhotos = false } = {}) {
  const log = [];
  const kinds = new Map(); // message_id → 'text' | 'photo'
  let nextId = 100;
  const push = (entry) => {
    const id = nextId++;
    kinds.set(id, entry.kind);
    log.push({ ...entry, message_id: id });
    return { message_id: id };
  };
  const tg = {
    log,
    async send(chatId, text, extra = {}) {
      assert.ok(typeof text === 'string' && text.length > 0, 'пустой текст сообщения');
      assert.ok(text.length <= 4096, 'сообщение длиннее лимита Telegram');
      checkHtml(text);
      checkMarkup(extra.reply_markup);
      return push({ kind: 'send', chatId, text, extra });
    },
    async photo(chatId, photo, caption = '', extra = {}) {
      assert.ok(caption.length <= 1024, 'подпись к фото длиннее 1024');
      checkHtml(caption);
      checkMarkup(extra.reply_markup);
      if (brokenPhotos) return null;
      return push({ kind: 'photo', chatId, text: caption, photo, extra });
    },
    async editText(chatId, messageId, text, extra = {}) {
      checkHtml(text);
      checkMarkup(extra.reply_markup);
      if (kinds.get(messageId) === 'photo') return null; // «there is no text in the message to edit»
      log.push({ kind: 'edit', chatId, text, extra, message_id: messageId });
      return true;
    },
    async answer() {
      return true;
    },
    async call(method, body) {
      log.push({ kind: 'call', method, chatId: body.chat_id, text: method, body });
      return true;
    },
  };
  return tg;
}

// Простейшая проверка HTML для parse_mode=HTML: только разрешённые теги и они закрыты
function checkHtml(text) {
  const tags = [...text.matchAll(/<\/?([a-z]+)[^>]*>/g)];
  const stack = [];
  for (const [full, name] of tags) {
    assert.ok(['b', 'i', 'u', 's', 'a', 'code', 'pre'].includes(name), `недопустимый тег ${full}`);
    if (full.startsWith('</')) assert.equal(stack.pop(), name, `тег ${name} закрыт не по порядку`);
    else stack.push(name);
  }
  assert.equal(stack.length, 0, 'незакрытый тег');
}

function checkMarkup(markup) {
  if (!markup || !markup.inline_keyboard) return;
  for (const row of markup.inline_keyboard) {
    for (const b of row) {
      assert.ok(b.text && b.text.length <= 64, `текст кнопки: ${b.text}`);
      if (b.callback_data !== undefined) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback_data > 64 байт: ${b.callback_data}`);
    }
  }
}

const ADMIN = 1000;
const GUEST = 2000;
const GUEST2 = 3000;
const env = { ADMIN_CHAT_IDS: String(ADMIN), PUBLIC_URL: 'https://example.vercel.app' };

let seq = 0;
function freshStore() {
  seq++;
  return createStore({ __memory: new Map(), __memoryId: `t${seq}` });
}

let mid = 1;
const msg = (chatId, text, extra = {}) => ({
  update_id: mid++,
  message: { message_id: mid++, chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Гость', username: 'guest' }, text, ...extra },
});
const cb = (chatId, data, messageId = 9) => ({
  update_id: mid++,
  callback_query: { id: 'cb', from: { id: chatId, first_name: 'Гость' }, data, message: { message_id: messageId, chat: { id: chatId } } },
});

function setup(nowIso = '2026-10-29T10:00:00Z', tgOpts) {
  const store = freshStore();
  const tg = fakeTg(tgOpts);
  const ctx = { tg, store, env, now: new Date(nowIso) };
  const run = (u, now) => handleUpdate(u, now ? { ...ctx, now: new Date(now) } : ctx);
  const db = async () => (await store.get('db', { events: [], promos: [], bookings: [] }));
  const same = (a, b) => String(a) === String(b);
  const last = (chatId) => [...tg.log].reverse().find((x) => x.kind !== 'call' && same(x.chatId, chatId));
  const textsTo = (chatId) => tg.log.filter((x) => same(x.chatId, chatId)).map((x) => x.text).join('\n---\n');
  return { store, tg, ctx, run, db, last, textsTo };
}

async function addEvent(run, text = 'UFC — главный бой, 01.11 21:00') {
  await run(cb(ADMIN, 'adm:ev'));
  await run(msg(ADMIN, text));
}

const pp = (eventId, n) => `pp:${eventId}.${n}`;

async function book(run, chatId, eventId, people = 4, name = 'Ирина', phone = '+995 555 12 34 56') {
  await run(cb(chatId, `bk:${eventId}`));
  await run(cb(chatId, pp(eventId, people)));
  await run(msg(chatId, name));
  await run(msg(chatId, phone));
}

// ---------- время ----------

test('время: разбор дат по Батуми (UTC+4)', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  assert.equal(parseLocalDateTime('01.11 21:00', now), '2026-11-01T17:00:00.000Z');
  assert.equal(parseLocalDateTime('31.02 21:00', now), null);
  assert.equal(parseLocalDateTime('не дата', now), null);
  assert.equal(extractDateTime('Барселона — Реал, 01.11 21:00', now).title, 'Барселона — Реал');
  assert.equal(extractDateTime('UFC 21.00 завтра', now).error, 'nodate');
  assert.equal(extractDateTime('Бокс 01.11 в 21.30', now).startsAt, '2026-11-01T17:30:00.000Z');
  // Январь в конце года: без года берётся следующий
  const dec = new Date('2026-12-30T10:00:00Z');
  assert.equal(extractDateTime('Матч 02.01 20:00', dec).startsAt, '2027-01-02T16:00:00.000Z');
  assert.equal(extractDateTime('Матч 25:00 01.11', now).error, 'nodate');
  assert.equal(extractDateTime('Матч 01.11 25:00', now).error, 'date');
});

// ---------- гость ----------

test('гость: /start, приветствие с фото и клавиатурой, пользователь сохранён один раз', async () => {
  const { run, last, store } = setup();
  await run(msg(GUEST, '/start'));
  const w = last(GUEST);
  assert.equal(w.kind, 'photo');
  assert.ok(w.text.includes('BOILER ROOM'));
  assert.ok(w.extra.reply_markup.keyboard.flat().some((b) => b.text === '🍽 Меню'));
  assert.ok(!w.extra.reply_markup.keyboard.flat().some((b) => b.text.includes('Админ')), 'гостю нет админ-кнопки');
  const writes = store.stats.writes;
  await run(msg(GUEST, '/start'));
  await run(msg(GUEST, '/start ref_instagram'));
  await run(msg(GUEST, '/start@BoilerRoomBatumi_bot'));
  assert.equal(store.stats.writes, writes, 'повторный /start не тратит запись');
  assert.deepEqual(Object.keys(await store.get('users')), [String(GUEST)]);
});

test('гость: если картинка не грузится, приветствие и карточки приходят текстом', async () => {
  const { run, last } = setup(undefined, { brokenPhotos: true });
  await run(msg(GUEST, '/start'));
  assert.equal(last(GUEST).kind, 'send');
  assert.ok(last(GUEST).text.includes('BOILER ROOM'));
  await run(cb(GUEST, 'mi:0.0'));
  assert.equal(last(GUEST).kind, 'send');
  assert.ok(last(GUEST).text.includes('650 ₾'));
});

test('гость: полный путь брони → админ подтверждает → напоминание один раз', async () => {
  const { run, db, last, textsTo, tg } = setup();
  await addEvent(run);
  const eventId = (await db()).events[0].id;

  await run(msg(GUEST, '/start'));
  await run(msg(GUEST, '🏟 Забронировать стол'));
  assert.ok(last(GUEST).extra.reply_markup.inline_keyboard[0][0].callback_data === `bk:${eventId}`);
  await run(cb(GUEST, `bk:${eventId}`));
  assert.ok(last(GUEST).text.includes('Сколько будет гостей'));
  await run(cb(GUEST, pp(eventId, 4)));
  // кнопка с именем из Telegram
  assert.equal(last(GUEST).extra.reply_markup.keyboard[0][0].text, 'Гость');
  await run(msg(GUEST, 'Ирина'));
  await run(msg(GUEST, '+995 555 12 34 56'));
  assert.ok(last(GUEST).text.includes('Заявка отправлена'));

  let b = (await db()).bookings;
  assert.equal(b.length, 1);
  assert.equal(b[0].status, 'pending');
  const card = tg.log.find((x) => String(x.chatId) === String(ADMIN) && x.text.includes('Заявка на бронь'));
  assert.ok(card, 'админ получил заявку');
  assert.ok(card.text.includes('Ирина') && card.text.includes('+995 555 12 34 56') && card.text.includes('@guest'));

  await run(cb(ADMIN, `ok:${b[0].id}`));
  assert.equal((await db()).bookings[0].status, 'confirmed');
  assert.ok(textsTo(GUEST).includes('Стол забронирован'));
  // повторное нажатие «Подтвердить» не шлёт гостю второе сообщение
  const count = tg.log.filter((x) => String(x.chatId) === String(GUEST) && x.text.includes('Стол забронирован')).length;
  await run(cb(ADMIN, `ok:${b[0].id}`));
  await run(cb(ADMIN, `no:${b[0].id}`));
  assert.equal(tg.log.filter((x) => String(x.chatId) === String(GUEST) && x.text.includes('Стол забронирован')).length, count);
  assert.equal((await db()).bookings[0].status, 'confirmed', 'после подтверждения отклонить нельзя');
});

test('напоминания: окно перед началом, один раз, повторный запуск не дублирует', async () => {
  const s = setup();
  await addEvent(s.run, 'Матч 01.11 21:00'); // 17:00 UTC
  const eventId = (await s.db()).events[0].id;
  await book(s.run, GUEST, eventId);
  const bid = (await s.db()).bookings[0].id;
  await s.run(cb(ADMIN, `ok:${bid}`));

  const at = (iso) => runReminders({ tg: s.tg, store: s.store, env, now: new Date(iso) });
  assert.equal((await at('2026-11-01T15:00:00Z')).bookingReminders, 0, 'за 2 часа рано');
  const reads = s.store.stats.writes;
  await at('2026-11-01T15:30:00Z');
  assert.equal(s.store.stats.writes, reads, 'пустой запуск ничего не пишет');
  assert.equal((await at('2026-11-01T16:10:00Z')).bookingReminders, 1);
  assert.equal((await at('2026-11-01T16:25:00Z')).bookingReminders, 0);
  // два запуска одновременно — одно напоминание
  const r = await Promise.all([at('2026-11-01T16:40:00Z'), at('2026-11-01T16:40:00Z')]);
  assert.equal(r[0].bookingReminders + r[1].bookingReminders, 0);
  const rem = s.tg.log.filter((x) => String(x.chatId) === String(GUEST) && x.text.includes('Напоминание о брони'));
  assert.equal(rem.length, 1);
  assert.ok(rem[0].text.includes('21:00'), 'в напоминании местное время начала');
});

test('напоминания: неподтверждённая или отклонённая бронь напоминание не получает', async () => {
  const s = setup();
  await addEvent(s.run, 'Матч 01.11 21:00');
  const eventId = (await s.db()).events[0].id;
  await book(s.run, GUEST, eventId);
  await book(s.run, GUEST2, eventId);
  const [b1] = (await s.db()).bookings;
  await s.run(cb(ADMIN, `no:${b1.id}`));
  assert.ok(s.textsTo(GUEST).includes('не получилось подтвердить'));
  const r = await runReminders({ tg: s.tg, store: s.store, env, now: new Date('2026-11-01T16:30:00Z') });
  assert.equal(r.bookingReminders, 0);
});

test('одновременные брони двух гостей не теряются', async () => {
  const s = setup();
  await addEvent(s.run);
  const eventId = (await s.db()).events[0].id;
  for (const g of [GUEST, GUEST2]) {
    await s.run(cb(g, `bk:${eventId}`));
    await s.run(cb(g, pp(eventId, 2)));
    await s.run(msg(g, `Имя ${g}`));
  }
  await Promise.all([s.run(msg(GUEST, '+995 555 000 001')), s.run(msg(GUEST2, '+995 555 000 002'))]);
  assert.equal((await s.db()).bookings.length, 2);
});

test('бронь: неверный телефон, контакт кнопкой, отмена посреди сценария', async () => {
  const s = setup();
  await addEvent(s.run);
  const eventId = (await s.db()).events[0].id;
  await s.run(cb(GUEST, `bk:${eventId}`));
  assert.equal(s.last(GUEST).extra.reply_markup.inline_keyboard[0][0].callback_data, pp(eventId, 1));
  await s.run(cb(GUEST, pp(eventId, 2)));
  await s.run(msg(GUEST, 'Олег'));
  for (const bad of ['abc', '12', '++++++++', '+995 abc 12']) {
    await s.run(msg(GUEST, bad));
    assert.ok(s.last(GUEST).text.includes('номер введён неверно'), bad);
  }
  await s.run(msg(GUEST, '', { contact: { phone_number: '995555123456' } }));
  assert.equal((await s.db()).bookings.length, 1);

  // отмена
  await s.run(cb(GUEST, `bk:${eventId}`));
  await s.run(cb(GUEST, pp(eventId, 3)));
  await s.run(msg(GUEST, '❌ Отмена'));
  assert.equal(s.last(GUEST).text, 'Отменено.');
  await s.run(msg(GUEST, 'Пётр'));
  assert.equal((await s.db()).bookings.length, 1, 'после отмены имя не продолжает бронь');
  // кнопка меню посреди брони тоже прерывает сценарий
  await s.run(cb(GUEST, `bk:${eventId}`));
  await s.run(cb(GUEST, pp(eventId, 3)));
  await s.run(msg(GUEST, '🍽 Меню'));
  assert.equal(await s.store.get(`s:${GUEST}`), null);
});

test('бронь: трансляцию удалили, пока гость заполнял — честное сообщение, заявки нет', async () => {
  const s = setup();
  await addEvent(s.run);
  const eventId = (await s.db()).events[0].id;
  await s.run(cb(GUEST, `bk:${eventId}`));
  await s.run(cb(GUEST, pp(eventId, 2)));
  await s.run(msg(GUEST, 'Олег'));
  await s.run(cb(ADMIN, `dl:${eventId}`));
  await s.run(msg(GUEST, '+995 555 12 34 56'));
  assert.ok(s.last(GUEST).text.includes('уже прошла или удалена'));
  assert.equal((await s.db()).bookings.length, 0);
  await s.run(cb(GUEST, `bk:${eventId}`));
  assert.ok(s.last(GUEST).text.includes('уже недоступна'));
});

test('бронь: можно забронировать уже идущий матч (до 3 часов после начала)', async () => {
  const s = setup('2026-11-01T17:30:00Z'); // матч начался в 17:00
  await s.store.set('db', { events: [{ id: 'e1', title: 'Матч', startsAt: '2026-11-01T17:00:00.000Z' }], promos: [], bookings: [] });
  await book(s.run, GUEST, 'e1');
  assert.equal((await s.db()).bookings.length, 1);
});

test('забытый сценарий (больше 2 часов) не перехватывает обычные сообщения', async () => {
  const s = setup('2026-10-29T10:00:00Z');
  await s.run(cb(ADMIN, 'adm:ev'));
  await s.run(msg(ADMIN, 'привет'), '2026-10-29T13:00:00Z');
  assert.ok(s.last(ADMIN).text.includes('Выберите действие'));
});

test('ни одна кнопка не роняет бота: мусорные callback и сообщения', async () => {
  const s = setup();
  const junk = ['', 'mc:', 'mc:abc', 'mc:-1', 'mi:', 'mi:1', 'mi:a.b', 'bk:', 'bk:nope', 'pp:abc', 'pp:x.y', 'pp:.5', 'ok:', 'no:x', 'adm:zzz', 'pw:9', 'pu', 'ann:x', 'pann:x', 'dl:x', 'dp:x', 'bc:send', 'bc:cancel', 'zzz:1'];
  for (const d of junk) {
    await s.run(cb(GUEST, d));
    await s.run(cb(ADMIN, d));
  }
  await s.run(msg(GUEST, '', { sticker: { file_id: 'x' } }));
  await s.run(msg(GUEST, '', { photo: [{ file_id: 'p' }] }));
  await s.run(msg(GUEST, '<b>тег</b> & <script>'));
  await s.run({ update_id: 1, edited_message: {} });
  await s.run({ update_id: 1, message: { message_id: 1, chat: { id: -100, type: 'group' }, text: '/start' } });
  assert.ok(!s.tg.log.some((x) => x.chatId === -100), 'в группах бот молчит');
});

// ---------- меню ----------

test('меню: 64 позиции, разделы, карточки, возврат из карточки с фото', async () => {
  assert.equal(MENU.reduce((n, c) => n + c.items.length, 0), 64);
  assert.ok(MENU.every((c) => c.items.every(([n, price, , img]) => n && price > 0 && img)));

  const s = setup();
  await s.run(msg(GUEST, '/start')); // прогрев кэша списка админов
  const reads0 = s.store.stats.reads;
  await s.run(msg(GUEST, '🍽 Меню'));
  const root = s.last(GUEST);
  assert.ok(root.text.includes('Меню BOILER ROOM'));
  assert.equal(root.extra.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data.startsWith('mc:')).length, MENU.length);

  // Каждый раздел и каждая позиция открываются
  for (let ci = 0; ci < MENU.length; ci++) {
    await s.run(cb(GUEST, `mc:${ci}`, root.message_id));
    assert.ok(s.last(GUEST).text.includes(MENU[ci].title));
    for (let ii = 0; ii < MENU[ci].items.length; ii++) {
      await s.run(cb(GUEST, `mi:${ci}.${ii}`));
      const card = s.last(GUEST);
      assert.equal(card.kind, 'photo');
      assert.ok(card.photo.startsWith('https://cdn.foodsoul.pro/'));
      assert.ok(card.text.includes(`${MENU[ci].items[ii][1]} ₾`));
    }
  }
  assert.equal(s.store.stats.reads - reads0, 0, 'листание меню не тратит лимит хранилища');

  // «🍽 Меню» на карточке с фото → новое сообщение с разделами, карточка удаляется
  await s.run(cb(GUEST, 'mi:0.0'));
  const card = s.last(GUEST);
  await s.run(cb(GUEST, 'mn', card.message_id));
  assert.ok(s.last(GUEST).text.includes('Меню BOILER ROOM'));
  assert.ok(s.tg.log.some((x) => x.method === 'deleteMessage' && x.body.message_id === card.message_id));
  // «⬅️ Раздел» на карточке
  await s.run(cb(GUEST, 'mi:2.1'));
  const card2 = s.last(GUEST);
  await s.run(cb(GUEST, 'mc:2', card2.message_id));
  assert.ok(s.last(GUEST).text.includes(MENU[2].title));
  // «Все разделы» в текстовом сообщении редактирует его на месте
  const catMsg = s.last(GUEST);
  await s.run(cb(GUEST, 'mn', catMsg.message_id));
  assert.equal(s.last(GUEST).kind, 'edit');
});

test('адрес и часы: текст + точка на карте', async () => {
  const s = setup();
  await s.run(msg(GUEST, '📍 Адрес и часы'));
  assert.ok(s.textsTo(GUEST).includes('Sherif Khimshiashvili'));
  assert.ok(s.tg.log.some((x) => x.method === 'sendLocation'));
});

// ---------- админ ----------

test('админ: вход по коду, неверный код, сообщение с кодом удаляется', async () => {
  const store = freshStore();
  const tg = fakeTg();
  const codeEnv = { ...env, ADMIN_CHAT_IDS: '', ADMIN_CODE: 'secret42' };
  const run = (u) => handleUpdate(u, { tg, store, env: codeEnv, now: new Date() });

  await run(msg(GUEST, '/admin wrong'));
  assert.deepEqual(await store.get('admins', []), []);
  assert.ok(tg.log.some((x) => x.text === 'Неверный код.'));
  await run(msg(GUEST, '/admin'));
  assert.ok(!tg.log.some((x) => x.text === 'Админ-панель'));

  await run(msg(GUEST, '/admin secret42'));
  assert.deepEqual(await store.get('admins', []), [GUEST]);
  assert.ok(tg.log.some((x) => x.method === 'deleteMessage'));
  await run(msg(GUEST, '/admin secret42')); // повторно — без дубля
  assert.deepEqual(await store.get('admins', []), [GUEST]);
  await run(msg(GUEST, '⚙️ Админ-панель'));
  assert.ok(tg.log.some((x) => x.text === 'Админ-панель'));
});

test('гость не может вызывать админские действия ни кнопками, ни текстом', async () => {
  const s = setup();
  await addEvent(s.run);
  const eventId = (await s.db()).events[0].id;
  for (const d of ['adm:ev', 'adm:pr', 'adm:bc', 'adm:bk', 'adm:sc', `dl:${eventId}`, `ann:${eventId}`, 'bc:send']) await s.run(cb(GUEST, d));
  await s.run(msg(GUEST, 'Барселона — Реал 01.11 21:00'));
  await s.run(msg(GUEST, '⚙️ Админ-панель'));
  assert.equal((await s.db()).events.length, 1);
  assert.equal(await s.store.get(`s:${GUEST}`), null);
  assert.ok(!s.textsTo(GUEST).includes('Админ-панель'));
});

test('админ: трансляция одним сообщением — подпись к фото, «завтра», фото отдельно, быстрый путь', async () => {
  const s = setup('2026-10-29T10:00:00Z');
  await s.run(cb(ADMIN, 'adm:ev'));
  await s.run(msg(ADMIN, '', { caption: 'Барселона — Реал 01.11 21:00', photo: [{ file_id: 'small' }, { file_id: 'BIG' }] }));
  await s.run(msg(ADMIN, 'UFC главный бой завтра 23:00'));
  await s.run(cb(ADMIN, 'adm:ev'));
  await s.run(msg(ADMIN, '', { photo: [{ file_id: 'POSTER' }] }));
  await s.run(msg(ADMIN, 'Бокс, 02.11 20:30'));

  const events = (await s.db()).events;
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
  assert.equal(events.length, 3);
  assert.equal(byTitle['Барселона — Реал'].photo, 'BIG');
  assert.equal(byTitle['Барселона — Реал'].startsAt, '2026-11-01T17:00:00.000Z');
  assert.equal(byTitle['UFC главный бой'].startsAt, '2026-10-30T19:00:00.000Z');
  assert.equal(byTitle['Бокс'].photo, 'POSTER');
  // после создания у админа снова обычная клавиатура
  assert.ok(s.last(ADMIN).extra.reply_markup.keyboard.flat().some((b) => b.text === '⚙️ Админ-панель'));

  // гость видит все три, с афишами
  await s.run(msg(GUEST, '📅 Трансляции'));
  const shown = s.tg.log.filter((x) => String(x.chatId) === String(GUEST) && x.kind === 'photo');
  assert.equal(shown.length, 3);
  assert.equal(shown[0].text.includes('UFC главный бой'), true, 'по времени: ближайшая первой');
});

test('админ: понятные ошибки при добавлении трансляции', async () => {
  const s = setup();
  await s.run(cb(ADMIN, 'adm:ev'));
  await s.run(msg(ADMIN, 'Просто название'));
  assert.ok(s.last(ADMIN).text.includes('Не нашёл дату'));
  await s.run(msg(ADMIN, 'Матч 31.02 21:00'));
  assert.ok(s.last(ADMIN).text.includes('нет в календаре'));
  await s.run(msg(ADMIN, '01.11 21:00'));
  assert.ok(s.last(ADMIN).text.includes('Не хватает названия'));
  await s.run(msg(ADMIN, 'Матч сегодня 25:00'));
  assert.ok(s.last(ADMIN).text.includes('Время указано неверно'));
  assert.equal((await s.db()).events.length, 0);
});

test('админ: длинное название и HTML в названии не ломают сообщения', async () => {
  const s = setup();
  await addEvent(s.run, `<b>Финал</b> & ${'очень длинное название '.repeat(10)} 01.11 21:00`);
  const e = (await s.db()).events[0];
  assert.ok(e.title.length <= 100);
  await s.run(msg(GUEST, '📅 Трансляции'));
  await s.run(msg(GUEST, '🏟 Забронировать стол'));
  await s.run(cb(ADMIN, `ann:${e.id}`));
});

test('админ: акции — по дню недели и до даты, видны гостям, удаляются', async () => {
  const s = setup('2026-10-29T10:00:00Z');
  await s.run(cb(ADMIN, 'adm:pr'));
  await s.run(msg(ADMIN, '2+1 по средам'));
  await s.run(msg(ADMIN, 'Третье пиво в подарок'));
  await s.run(msg(ADMIN, 'текст вместо фото'));
  assert.ok(s.last(ADMIN).text.includes('Без фото'));
  await s.run(msg(ADMIN, '⏭ Без фото'));
  await s.run(cb(ADMIN, 'pw:3'));
  assert.ok(s.textsTo(ADMIN).includes('каждую среду'));

  await s.run(cb(ADMIN, 'adm:pr'));
  await s.run(msg(ADMIN, 'Скидка на раков'));
  await s.run(msg(ADMIN, '-20% на раков L'));
  await s.run(msg(ADMIN, '', { photo: [{ file_id: 'RAKI' }] }));
  await s.run(cb(ADMIN, 'pu'));
  await s.run(msg(ADMIN, '01.01.2020'));
  assert.ok(s.last(ADMIN).text.includes('уже прошла'));
  await s.run(msg(ADMIN, '15.11'));
  assert.ok(s.textsTo(ADMIN).includes('до 15.11 включительно'));

  await s.run(msg(GUEST, '🎁 Акции'));
  const t = s.textsTo(GUEST);
  assert.ok(t.includes('2+1 по средам') && t.includes('Скидка на раков'));

  const promos = (await s.db()).promos;
  assert.equal(promos.length, 2);
  await s.run(cb(ADMIN, `dp:${promos[0].id}`));
  assert.equal((await s.db()).promos.length, 1);
  // акция «до даты» после этой даты исчезает
  await s.run(msg(GUEST, '🎁 Акции'), '2026-11-16T10:00:00Z');
  assert.ok(s.last(GUEST).text.includes('активных акций нет'));
});

test('еженедельная акция уходит всем в нужный день после 12:00, один раз за день', async () => {
  const s = setup();
  await s.run(msg(GUEST, '/start'));
  await s.run(msg(GUEST2, '/start'));
  await s.store.set('db', { events: [], bookings: [], promos: [{ id: 'p1', title: '2+1', text: 'Два плюс один', photo: null, kind: 'weekly', weekday: 3, until: null, lastRemindedDate: null }] });
  const at = (iso) => runReminders({ tg: s.tg, store: s.store, env, now: new Date(iso) });
  assert.equal((await at('2026-10-28T11:30:00+04:00')).weeklyPromos, 0, 'до 12:00 рано');
  assert.equal((await at('2026-10-28T12:30:00+04:00')).weeklyPromos, 2);
  assert.equal((await at('2026-10-28T18:00:00+04:00')).weeklyPromos, 0);
  assert.equal((await at('2026-10-29T12:30:00+04:00')).weeklyPromos, 0, 'в четверг не шлём');
  assert.equal((await at('2026-11-04T12:30:00+04:00')).weeklyPromos, 2, 'следующая среда');
});

test('рассылка: подтверждение, отмена, HTML экранируется, двойное нажатие не дублирует', async () => {
  const s = setup();
  for (const g of [GUEST, GUEST2]) await s.run(msg(g, '/start'));
  await s.run(cb(ADMIN, 'adm:bc'));
  await s.run(msg(ADMIN, 'Сегодня <жарко> & весело'));
  assert.ok(s.last(ADMIN).text.includes('всем гостям (2)'));
  await s.run(cb(ADMIN, 'bc:send'));
  await s.run(cb(ADMIN, 'bc:send'));
  assert.equal(s.tg.log.filter((x) => x.text === 'Сегодня &lt;жарко&gt; &amp; весело').length, 2);

  await s.run(cb(ADMIN, 'adm:bc'));
  await s.run(msg(ADMIN, 'Не отправлять'));
  await s.run(cb(ADMIN, 'bc:cancel'));
  assert.ok(!s.tg.log.some((x) => String(x.chatId) === String(GUEST) && x.text === 'Не отправлять'));
});

test('анонс трансляции приходит гостям с кнопкой брони', async () => {
  const s = setup();
  await s.run(msg(GUEST, '/start'));
  await addEvent(s.run);
  const e = (await s.db()).events[0];
  await s.run(cb(ADMIN, `ann:${e.id}`));
  const a = s.last(GUEST);
  assert.ok(a.text.includes(e.title));
  assert.equal(a.extra.reply_markup.inline_keyboard[0][0].callback_data, `bk:${e.id}`);
});

test('админ: заявки и расписание показывают актуальное, удаление трансляции', async () => {
  const s = setup();
  await s.run(cb(ADMIN, 'adm:bk'));
  assert.ok(s.last(ADMIN).text.includes('Новых заявок нет'));
  await s.run(cb(ADMIN, 'adm:sc'));
  assert.ok(s.last(ADMIN).text.includes('Расписание пустое'));
  await addEvent(s.run);
  const e = (await s.db()).events[0];
  await book(s.run, GUEST, e.id, 3);
  await s.run(cb(ADMIN, 'adm:bk'));
  assert.ok(s.last(ADMIN).text.includes('Заявка на бронь'));
  await s.run(cb(ADMIN, `ok:${(await s.db()).bookings[0].id}`));
  await s.run(cb(ADMIN, 'adm:sc'));
  assert.ok(s.textsTo(ADMIN).includes('Подтверждено броней: 1 (гостей ~3)'));
  await s.run(cb(ADMIN, `dl:${e.id}`));
  await s.run(cb(ADMIN, `dl:${e.id}`));
  assert.equal((await s.db()).events.length, 0);
});

test('прошедшие трансляции не видны и чистятся напоминаниями', async () => {
  const s = setup();
  await s.store.set('db', {
    events: [
      { id: 'old', title: 'Старый', startsAt: '2026-10-28T10:00:00Z' },
      { id: 'new', title: 'Новый', startsAt: '2026-10-29T16:00:00Z' },
    ],
    promos: [],
    bookings: [],
  });
  await s.run(msg(GUEST, '📅 Трансляции'));
  assert.ok(s.textsTo(GUEST).includes('Новый'));
  assert.ok(!s.textsTo(GUEST).includes('Старый'));
  await runReminders({ tg: s.tg, store: s.store, env, now: new Date('2026-10-29T10:00:00Z') });
  assert.deepEqual((await s.db()).events.map((e) => e.id), ['new']);
});

test('перенос данных со старой схемы (отдельные ключи) в один документ', async () => {
  const s = setup();
  await s.store.set('events', [{ id: 'e1', title: 'Старый формат', startsAt: '2026-11-01T17:00:00.000Z' }]);
  await s.store.set('promos', [{ id: 'p1', title: 'Акция', kind: 'weekly', weekday: 3 }]);
  await s.run(msg(GUEST, '📅 Трансляции'));
  assert.ok(s.textsTo(GUEST).includes('Старый формат'));
  const d = await s.store.get('db');
  assert.equal(d.events.length, 1);
  assert.equal(d.promos.length, 1);
});

test('бюджет хранилища: типичный месяц укладывается в бесплатный Blob', async () => {
  const s = setup();
  await addEvent(s.run);
  const eventId = (await s.db()).events[0].id;
  const r0 = s.store.stats.reads;
  const w0 = s.store.stats.writes;
  // Один гость: старт, меню, трансляции, бронь
  await s.run(msg(GUEST, '/start'));
  await s.run(msg(GUEST, '🍽 Меню'));
  await s.run(cb(GUEST, 'mc:0'));
  await s.run(cb(GUEST, 'mi:0.1'));
  await s.run(msg(GUEST, '📅 Трансляции'));
  await book(s.run, GUEST, eventId);
  const reads = s.store.stats.reads - r0;
  const writes = s.store.stats.writes - w0;
  console.log(`  один гость с бронью: чтений ${reads}, записей ${writes}`);
  assert.ok(reads <= 8, `чтений ${reads}`);
  assert.ok(writes <= 6, `записей ${writes}`);
  // Пустой запуск напоминаний — одно чтение, ноль записей
  const r1 = s.store.stats.reads;
  const w1 = s.store.stats.writes;
  await runReminders({ tg: s.tg, store: s.store, env, now: new Date('2026-10-29T11:00:00Z') });
  assert.equal(s.store.stats.reads - r1, 1);
  assert.equal(s.store.stats.writes - w1, 0);
});
