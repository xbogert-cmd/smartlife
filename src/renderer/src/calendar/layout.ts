import type { CalendarEvent } from './types';

export const GRID_START_HOUR = 6;
export const GRID_END_HOUR = 23;

const GRID_MINUTES = (GRID_END_HOUR - GRID_START_HOUR) * 60;
/** Percent of grid height below which a block would be unclickable. */
const MIN_HEIGHT_PCT = 1.5;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The LOCAL calendar date of a Date, as YYYY-MM-DD.
 *
 * Deliberately not toISOString().slice(0, 10): that returns the UTC date, so
 * an 8pm event in the US would be filed under the next day's column.
 */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parses a bare YYYY-MM-DD as LOCAL midnight.
 *
 * new Date('2026-08-21') is specified to parse as UTC midnight, which reads
 * back as the 20th anywhere west of Greenwich -- the single most common
 * all-day-event bug.
 */
export function parseAllDayDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Local midnight on the Sunday of the containing week. */
export function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_unused, index) => {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + index);
    return day;
  });
}

/** Every local date an event should appear under. */
export function eventDayKeys(event: CalendarEvent): string[] {
  if (!event.isAllDay) return [toDateKey(new Date(event.startAt))];

  const start = parseAllDayDate(event.startAt);
  const end = parseAllDayDate(event.endAt);
  const keys: string[] = [];
  const cursor = new Date(start);
  // Google's all-day end date is EXCLUSIVE: a one-day event on the 21st has
  // end = the 22nd, so the loop stops before it.
  while (cursor < end) {
    keys.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  // Defensive: a malformed event whose end equals its start still needs a day.
  if (keys.length === 0) keys.push(toDateKey(start));
  return keys;
}

/** Minutes past local midnight to a percentage of the visible grid height. */
export function minutesToPercent(minutes: number): number {
  const offset = minutes - GRID_START_HOUR * 60;
  // Clamped so an event outside the visible hours pins to an edge instead of
  // rendering off-grid at a negative offset.
  return Math.min(100, Math.max(0, (offset / GRID_MINUTES) * 100));
}

export interface PositionedEvent {
  event: CalendarEvent;
  topPct: number;
  heightPct: number;
  columnIndex: number;
  columnCount: number;
}

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Positions one day's timed events, splitting overlapping ones into columns.
 *
 * Events are grouped into clusters of transitively-overlapping events, and
 * every event in a cluster gets the same columnCount so their widths line up.
 * Columns are assigned greedily to the first one whose last event has ended.
 */
export function layoutDayEvents(events: CalendarEvent[]): PositionedEvent[] {
  const sorted = [...events]
    .filter((event) => !event.isAllDay)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  const positioned: PositionedEvent[] = [];
  let cluster: CalendarEvent[] = [];
  let clusterEnd = -1;

  function flush(): void {
    if (cluster.length === 0) return;
    // Greedy column packing: reuse a column as soon as its previous event ends.
    const columnEnds: number[] = [];
    const assignments = cluster.map((event) => {
      const start = minutesOf(new Date(event.startAt));
      const end = minutesOf(new Date(event.endAt));
      let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(end);
      } else {
        columnEnds[column] = end;
      }
      return { event, start, end, column };
    });

    for (const item of assignments) {
      const topPct = minutesToPercent(item.start);
      const rawHeight = minutesToPercent(item.end) - topPct;
      positioned.push({
        event: item.event,
        topPct,
        heightPct: Math.max(MIN_HEIGHT_PCT, rawHeight),
        columnIndex: item.column,
        columnCount: columnEnds.length,
      });
    }

    cluster = [];
    clusterEnd = -1;
  }

  for (const event of sorted) {
    const start = minutesOf(new Date(event.startAt));
    const end = minutesOf(new Date(event.endAt));
    // Back-to-back events (previous end == this start) do not overlap, so the
    // comparison is strict.
    if (cluster.length > 0 && start >= clusterEnd) flush();
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return positioned;
}
