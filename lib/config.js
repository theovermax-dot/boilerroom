// Данные заведения. Всё, что помечено TODO, нужно уточнить перед показом гостям.
export const VENUE = {
  name: 'BOILER ROOM',
  city: 'Batumi',
  address: 'TODO: адрес заведения',
  hours: 'TODO: часы работы',
  phone: 'TODO: телефон',
  instagram: 'https://instagram.com/boilerroombatumi',
  // Часовой пояс Батуми: UTC+4, без перехода на летнее время
  utcOffsetHours: 4,
};

// Напоминание о регулярных акциях уходит в этот час (по Батуми)
export const WEEKLY_REMINDER_HOUR = 12;
// За сколько до начала трансляции гость получает напоминание
export const BOOKING_REMINDER_MINUTES = 60;
// Через сколько часов после начала трансляция считается прошедшей и удаляется
export const EVENT_GRACE_HOURS = 3;
