import { toDateKey } from './layout';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * ISO timestamp -> the value an <input type="datetime-local"> expects, which
 * is LOCAL wall-clock with no zone. Slicing the ISO string instead would show
 * the UTC hour and shift every event the user opens.
 */
export function toDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  return `${toDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local value -> ISO. `new Date('...T14:30')` parses as local time. */
export function fromDateTimeInputValue(value: string): string {
  return new Date(value).toISOString();
}

/** Either an all-day date string or a timestamp -> a bare local YYYY-MM-DD. */
export function toDateInputValue(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return toDateKey(new Date(value));
}
