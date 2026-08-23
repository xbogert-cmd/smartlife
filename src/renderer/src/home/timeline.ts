import { eventDayKeys, parseAllDayDate, toDateKey } from '../calendar/layout';
import type { CalendarEvent } from '../calendar/types';
import type { UpcomingAssignment } from '../school/types';

/**
 * One line of the Home agenda. `at` is epoch milliseconds -- local midnight
 * for an all-day event, the start instant otherwise -- so sorting never has
 * to reason about two different date shapes.
 */
export type TodayItem =
  | { kind: 'event'; at: number; allDay: boolean; event: CalendarEvent }
  | { kind: 'due'; at: number; assignment: UpcomingAssignment };

function rank(item: TodayItem): number {
  // All-day events have no meaningful time of day, so they head the list
  // rather than sorting to local midnight among the early-morning items.
  return item.kind === 'event' && item.allDay ? 0 : 1;
}

function compare(a: TodayItem, b: TodayItem): number {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  if (a.at !== b.at) return a.at - b.at;
  // A class you have to be at outranks a deadline you can meet from anywhere.
  if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
  return 0;
}

/**
 * Today's calendar events and assignment due times, interleaved in the order
 * they happen. The only surface in the app that shows both together.
 */
export function buildToday(
  events: CalendarEvent[],
  assignments: UpcomingAssignment[],
  now: Date = new Date()
): TodayItem[] {
  const today = toDateKey(now);
  const items: TodayItem[] = [];

  for (const event of events) {
    if (!eventDayKeys(event).includes(today)) continue;
    const at = event.isAllDay ? parseAllDayDate(event.startAt).getTime() : Date.parse(event.startAt);
    if (Number.isNaN(at)) continue;
    items.push({ kind: 'event', at, allDay: event.isAllDay, event });
  }

  for (const assignment of assignments) {
    const at = Date.parse(assignment.dueAt);
    if (Number.isNaN(at)) continue;
    if (toDateKey(new Date(at)) !== today) continue;
    items.push({ kind: 'due', at, assignment });
  }

  return items.sort(compare);
}
