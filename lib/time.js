import { VENUE, EVENT_GRACE_HOURS } from './config.js';

const OFFSET_MS = VENUE.utcOffsetHours * 3600e3;
const DAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const pad = (n) => String(n).padStart(2, '0');

// Возвращает Date, у которого UTC-поля совпадают с местным временем Батуми
export function toLocal(date) {
  return new Date(date.getTime() + OFFSET_MS);
}

export function localDateKey(date) {
  const d = toLocal(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function localWeekday(date) {
  return toLocal(date).getUTCDay();
}

export function localHour(date) {
  return toLocal(date).getUTCHours();
}

// «01.11 вс 21:00»
export function formatEventTime(iso) {
  const d = toLocal(new Date(iso));
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${DAYS_SHORT[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function weekdayName(weekday) {
  return DAYS_FULL[weekday];
}

// Разбирает «01.11 21:00» (или «01.11.2026 21:00») как местное время Батуми.
// Возвращает ISO-строку в UTC или null, если формат неверный.
export function parseLocalDateTime(input, now = new Date()) {
  const m = input.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const day = Number(dd);
  const month = Number(mm) - 1;
  const hour = Number(hh);
  const minute = Number(min);
  if (hour > 23 || minute > 59) return null;
  const localNow = toLocal(now);
  let year = yyyy ? Number(yyyy) : localNow.getUTCFullYear();
  let utc = Date.UTC(year, month, day, hour, minute) - OFFSET_MS;
  const check = toLocal(new Date(utc));
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month) return null;
  // Без года: если дата уже прошла, берём следующий год
  if (!yyyy && utc < now.getTime() - EVENT_GRACE_HOURS * 3600e3) {
    utc = Date.UTC(year + 1, month, day, hour, minute) - OFFSET_MS;
  }
  return new Date(utc).toISOString();
}

// «01.11» → ISO конца этого дня по Батуми
export function parseLocalDate(input, now = new Date()) {
  const m = input.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  const year = m[3] ? Number(m[3]) : toLocal(now).getUTCFullYear();
  const utc = Date.UTC(year, month, day, 23, 59, 59) - OFFSET_MS;
  const check = toLocal(new Date(utc));
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month) return null;
  return new Date(utc).toISOString();
}

// Достаёт дату и время из свободного текста: «Барселона — Реал 01.11 21:00», «UFC завтра 23:00».
// Возвращает { startsAt, title } или { error }.
export function extractDateTime(input, now = new Date()) {
  const text = String(input || '');
  let startsAt = null;
  let matched = null;

  const rel = text.match(/(сегодня|завтра|послезавтра)\s*(?:в\s*)?(\d{1,2})[:.](\d{2})/i);
  if (rel) {
    const shift = { сегодня: 0, завтра: 1, послезавтра: 2 }[rel[1].toLowerCase()];
    const hour = Number(rel[2]);
    const minute = Number(rel[3]);
    if (hour > 23 || minute > 59) return { error: 'time' };
    const local = toLocal(now);
    const utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + shift, hour, minute) - OFFSET_MS;
    startsAt = new Date(utc).toISOString();
    matched = rel[0];
  } else {
    const abs = text.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s*(?:в\s*)?(\d{1,2})[:.](\d{2})/);
    if (abs) {
      const dateTime = `${abs[1]}.${abs[2]}${abs[3] ? '.' + abs[3] : ''} ${abs[4]}:${abs[5]}`;
      startsAt = parseLocalDateTime(dateTime, now);
      if (!startsAt) return { error: 'date' };
      matched = abs[0];
    }
  }
  if (!startsAt) return { error: 'nodate' };
  if (new Date(startsAt).getTime() < now.getTime() - EVENT_GRACE_HOURS * 3600e3) return { error: 'past' };

  const title = text
    .replace(matched, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|—–-]+|[\s,;:|—–-]+$/g, '')
    .slice(0, 100);
  return { startsAt, title };
}
