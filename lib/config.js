// Данные заведения (адрес, телефон, часы и координаты взяты с boilerroombatumi.com).
export const VENUE = {
  name: 'BOILER ROOM',
  city: 'Batumi',
  address: 'Batumi, 4 Sherif Khimshiashvili St',
  hours: 'Пн–Сб 11:00–01:00, Вс 11:00–00:00',
  phone: '+995 593 222 325',
  website: 'https://boilerroombatumi.com',
  latitude: 41.6432251,
  longitude: 41.6167808,
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
