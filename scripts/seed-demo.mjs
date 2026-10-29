// Наполняет хранилище демо-данными: две трансляции на вечер и акция «2+1 по средам».
// Запуск с теми же переменными, что и на сервере (UPSTASH_*). Без них пишет в память и ничего не сохранит.
import { createStore } from '../lib/store.js';

const store = createStore();
const now = new Date();
const hoursFromNow = (h) => new Date(now.getTime() + h * 3600e3).toISOString();

const events = [
  { id: 'demo-ufc', title: 'UFC — главный бой вечера', startsAt: hoursFromNow(3), photo: null, createdAt: now.toISOString() },
  { id: 'demo-football', title: 'Футбол — Лига чемпионов', startsAt: hoursFromNow(6), photo: null, createdAt: now.toISOString() },
];

const promos = [
  {
    id: 'demo-2plus1',
    title: '2+1 по средам',
    text: 'Берёте два напитка — третий в подарок.',
    photo: null,
    kind: 'weekly',
    weekday: 3,
    until: null,
    lastRemindedDate: null,
    createdAt: now.toISOString(),
  },
];

await store.set('events', events);
await store.set('promos', promos);
console.log(store.isRemote ? 'Демо-данные записаны в Upstash.' : 'Нет UPSTASH_* переменных: данные только в памяти процесса.');
