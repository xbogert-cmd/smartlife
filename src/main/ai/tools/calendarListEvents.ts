import type { ToolDefinition } from './types';
import { getEventsInRange, listCalendarRows } from '../../calendar/queries';

/**
 * Local (not UTC) YYYY-MM-DD. `new Date().toISOString().slice(0, 10)` gives
 * the UTC date, which is the wrong day for anyone west of UTC in the evening
 * -- the same bug this app's all-day-event handling deliberately avoids.
 */
function todayLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const calendarListEventsTool: ToolDefinition = {
  name: 'calendar_list_events',
  tier: 'READ',
  label: 'Read calendar events',
  schema: {
    name: 'calendar_list_events',
    description:
      "List the user's Google Calendar events between two dates. Reads locally synced data, so it is instant, works offline, and consumes no Google quota. Use this to answer questions about the schedule and to find free time before proposing a new event.",
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Start date, YYYY-MM-DD (inclusive).' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD (inclusive).' },
      },
      required: ['start', 'end'],
    },
  },
  async run(input, ctx) {
    const start = String(input.start ?? '');
    const end = String(input.end ?? '');
    const events = getEventsInRange(ctx.db, start, end);

    // Prepended on every call, even an empty one: it's the only way the
    // model learns "today" (to build RFC3339 times) and a calendarId to
    // create against (the [calendarId=... eventId=...] suffix below is
    // otherwise the model's only source, and that's empty exactly when
    // there's nothing scheduled -- a fresh account or an empty week).
    const calendarLines = listCalendarRows(ctx.db)
      .filter((calendar) => calendar.enabled)
      .map((calendar) => `- ${calendar.summary} [calendarId=${calendar.id}]${calendar.isPrimary ? ' (primary)' : ''}`)
      .join('\n');
    const header = `Today is ${todayLocal()}.\nCalendars:\n${calendarLines}\n\n`;

    if (events.length === 0) return `${header}Nothing is scheduled between ${start} and ${end}.`;

    const lines = events.map((event) => {
      const when = event.isAllDay ? `${event.startAt} (all day)` : `${event.startAt} – ${event.endAt}`;
      const guests = event.hasGuests ? ` — ${event.guestCount} guests` : '';
      const where = event.location === null ? '' : ` @ ${event.location}`;
      // The calendarId/eventId pair is what the write tools need, so it has to
      // be in the output the model reads.
      return `- ${event.summary ?? 'Untitled'} — ${when}${where}${guests} [calendarId=${event.calendarId} eventId=${event.id}]`;
    });
    return `${header}Events between ${start} and ${end}:\n${lines.join('\n')}`;
  },
};
