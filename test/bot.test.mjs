import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, runReminders } from '../lib/bot.js';
import { parseLocalDateTime } from '../lib/time.js';

// Фейковый Telegram: записывает все исходящие сообщения
function fakeTg() {
  const log = [];
  const rec = (kind) => async (chatId, a, b, c) => {
    log.push({ kind, chatId, text: kind === 'photo' ? b : a, extra: kind === 'photo' ? c : b });
    return { message_id: log.length };
  };
  return {
    log,
    send: rec('send'),
    photo: rec('photo'),
    editText: async (chatId, id, text) => { log.push({ kind: 'edit', chatId, text }); return true; },
    answer: async () => true,
  };
}

// Память без Upstash
function memStore() {
  const m = new Map();
  return {
    async get(k, f = null) { return m.has(k) ? JSON.parse(m.get(k)) : f; },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async del(k) { m.delete(k); },
    isRemote: false,
  };
}

const ADMIN = 1000;
const GUEST = 2000;
const env = { ADMIN_CHAT_IDS: String(ADMIN), PUBLIC_URL: 'https://example.vercel.app' };
const msg = (chatId, text, extra = {}) => ({ update_id: 1, message: { message_id: 1, chat: { id: chatId }, from: { id: chatId, first_name: 'Гость', username: 'guest' }, text, ...extra } });
const cb = (chatId, data) => ({ update_id: 2, callback_query: { id: 'cb', from: { id: chatId }, data, message: { message_id: 9, chat: { id: chatId } } } });

function makeCtx(now, tg, store) {
  return { tg, store, env, now, isAdmin: (id) => id === ADMIN };
}

test('парсинг даты по Батуми (UTC+4)', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  assert.equal(parseLocalDateTime('01.11 21:00', now), '2026-11-01T17:00:00.000Z');
  assert.equal(parseLocalDateTime('31.02 21:00', now), null);
  assert.equal(parseLocalDateTime('не дата', now), null);
});

test('гость бронирует, админ подтверждает, гость получает напоминание за час', async () => {
  const store = memStore();
  const tg = fakeTg();
  const now = new Date('2026-10-29T10:00:00Z');
  const ctx = makeCtx(now, tg, store);

  // Админ создаёт трансляцию
  await handleUpdate(cb(ADMIN, 'adm:ev'), ctx);
  await handleUpdate(msg(ADMIN, 'UFC — главный бой'), ctx);
  await handleUpdate(msg(ADMIN, '01.11 21:00'), ctx);
  await handleUpdate(msg(ADMIN, '⏭ Без фото'), ctx);
  const events = await store.get('events');
  assert.equal(events.length, 1);
  const eventId = events[0].id;

  // Гость видит трансляцию и бронирует
  await handleUpdate(msg(GUEST, '🏟 Забронировать стол'), ctx);
  await handleUpdate(cb(GUEST, `bk:${eventId}`), ctx);
  await handleUpdate(cb(GUEST, 'pp:4'), ctx);
  await handleUpdate(msg(GUEST, 'Ирина'), ctx);
  await handleUpdate(msg(GUEST, '+995 555 12 34 56'), ctx);

  let bookings = await store.get('bookings');
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].status, 'pending');
  assert.equal(bookings[0].people, 4);
  // Заявка ушла админу с кнопками
  const adminCard = tg.log.find((x) => String(x.chatId) === String(ADMIN) && x.text.includes('Заявка на бронь'));
  assert.ok(adminCard, 'админ получил заявку');
  assert.ok(adminCard.extra.reply_markup.inline_keyboard[0][0].callback_data.startsWith('ok:'));

  // Админ подтверждает
  await handleUpdate(cb(ADMIN, `ok:${bookings[0].id}`), ctx);
  bookings = await store.get('bookings');
  assert.equal(bookings[0].status, 'confirmed');
  assert.ok(tg.log.some((x) => x.chatId === GUEST && x.text.includes('Стол забронирован')));

  // За 30 минут до начала — напоминание уходит один раз
  const reminderCtx = makeCtx(new Date('2026-11-01T16:30:00Z'), tg, store);
  const r1 = await runReminders(reminderCtx);
  assert.equal(r1.bookingReminders, 1);
  const r2 = await runReminders(reminderCtx);
  assert.equal(r2.bookingReminders, 0, 'повторно не шлём');
});

test('еженедельная акция «2+1 по средам» уходит всем в среду после 12:00 один раз', async () => {
  const store = memStore();
  const tg = fakeTg();
  const ctxWed = makeCtx(new Date('2026-10-28T12:30:00+04:00'), tg, store); // среда 12:30 Батуми
  await store.set('users', { [GUEST]: { name: 'Гость' }, [ADMIN]: { name: 'Админ' } });
  await store.set('promos', [{ id: 'p1', title: '2+1', text: 'Два плюс один', photo: null, kind: 'weekly', weekday: 3, until: null, lastRemindedDate: null }]);

  const r1 = await runReminders(ctxWed);
  assert.equal(r1.weeklyPromos, 2);
  const r2 = await runReminders(ctxWed);
  assert.equal(r2.weeklyPromos, 0);
});

test('прошедшие трансляции удаляются, гость не видит старые', async () => {
  const store = memStore();
  const tg = fakeTg();
  const now = new Date('2026-10-29T10:00:00Z');
  await store.set('events', [
    { id: 'old', title: 'Старый', startsAt: '2026-10-28T10:00:00Z' },
    { id: 'new', title: 'Новый', startsAt: '2026-10-29T16:00:00Z' },
  ]);
  const ctx = makeCtx(now, tg, store);
  await handleUpdate(msg(GUEST, '📅 Трансляции'), ctx);
  assert.ok(tg.log.some((x) => x.text.includes('Новый')));
  assert.ok(!tg.log.some((x) => x.text.includes('Старый')));
  await runReminders(ctx);
  const left = await store.get('events');
  assert.deepEqual(left.map((e) => e.id), ['new']);
});

test('не-админ не получает доступ к админ-панели', async () => {
  const store = memStore();
  const tg = fakeTg();
  const ctx = makeCtx(new Date(), tg, store);
  await handleUpdate(msg(GUEST, '/admin'), ctx);
  assert.ok(!tg.log.some((x) => x.text === 'Админ-панель'));
  await handleUpdate(cb(GUEST, 'adm:ev'), ctx);
  const session = await store.get(`s:${GUEST}`, null);
  assert.equal(session, null);
});

test('телефон в неверном формате не принимается', async () => {
  const store = memStore();
  const tg = fakeTg();
  const now = new Date('2026-10-29T10:00:00Z');
  const ctx = makeCtx(now, tg, store);
  await store.set('events', [{ id: 'e1', title: 'Матч', startsAt: '2026-11-01T17:00:00Z' }]);
  await handleUpdate(cb(GUEST, 'bk:e1'), ctx);
  await handleUpdate(cb(GUEST, 'pp:2'), ctx);
  await handleUpdate(msg(GUEST, 'Олег'), ctx);
  await handleUpdate(msg(GUEST, 'abc'), ctx);
  assert.equal(await store.get('bookings', []).then((b) => b.length), 0);
  assert.ok(tg.log.some((x) => x.text.includes('номер введён неверно')));
});

test('вход админа по коду, неверный код не работает, сообщение с кодом удаляется', async () => {
  const store = memStore();
  const tg = fakeTg();
  tg.call = async (method) => { tg.log.push({ kind: 'call', chatId: 0, text: method }); return true; };
  const codeEnv = { ...env, ADMIN_CHAT_IDS: '', ADMIN_CODE: 'secret42' };
  const ctx = { tg, store, env: codeEnv, now: new Date() };

  await handleUpdate(msg(GUEST, '/admin wrong'), ctx);
  assert.deepEqual(await store.get('admins', []), []);
  assert.ok(tg.log.some((x) => x.text === 'Неверный код.'));

  await handleUpdate(msg(GUEST, '/admin secret42'), ctx);
  assert.deepEqual(await store.get('admins', []), [GUEST]);
  assert.ok(tg.log.some((x) => x.text === 'deleteMessage'));

  await handleUpdate(msg(GUEST, '/admin'), ctx);
  assert.ok(tg.log.some((x) => x.text === 'Админ-панель'), 'после входа панель доступна');
});
