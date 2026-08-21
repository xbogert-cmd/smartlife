import { parseAllDayDate } from './layout';
import type { CalendarEvent } from './types';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function meridiem(hour: number): 'AM' | 'PM' {
  return hour < 12 ? 'AM' : 'PM';
}

function hour12(hour: number): number {
  const value = hour % 12;
  return value === 0 ? 12 : value;
}

export function formatHourLabel(hour: number): string {
  return `${hour12(hour)} ${meridiem(hour)}`;
}

export function formatDayHeader(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
}

function clockTime(date: Date): string {
  return `${hour12(date.getHours())}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * "2:00 – 3:30 PM" when both ends share a meridiem, "11:00 AM – 1:00 PM" when
 * they do not. Repeating AM/PM on both sides of every range is noisy in a grid
 * where most events sit inside one half of the day.
 */
export function formatEventTime(event: CalendarEvent): string {
  if (event.isAllDay) return 'All day';
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const startMeridiem = meridiem(start.getHours());
  const endMeridiem = meridiem(end.getHours());
  if (startMeridiem === endMeridiem) {
    return `${clockTime(start)} – ${clockTime(end)} ${endMeridiem}`;
  }
  return `${clockTime(start)} ${startMeridiem} – ${clockTime(end)} ${endMeridiem}`;
}

/** Long form including the date, used in AI confirmation prompts. */
export function formatEventRange(event: CalendarEvent): string {
  if (event.isAllDay) {
    const date = parseAllDayDate(event.startAt);
    return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}, all day`;
  }
  const start = new Date(event.startAt);
  return `${WEEKDAYS[start.getDay()]} ${MONTHS[start.getMonth()]} ${start.getDate()}, ${formatEventTime(event)}`;
}

export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'never';
  const elapsed = now.getTime() - Date.parse(iso);
  if (Number.isNaN(elapsed)) return 'never';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
