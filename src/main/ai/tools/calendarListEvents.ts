import type { ToolDefinition } from './types';
import { getEventsInRange } from '../../calendar/queries';

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
    if (events.length === 0) return `Nothing is scheduled between ${start} and ${end}.`;

    const lines = events.map((event) => {
      const when = event.isAllDay ? `${event.startAt} (all day)` : `${event.startAt} – ${event.endAt}`;
      const guests = event.hasGuests ? ` — ${event.guestCount} guests` : '';
      const where = event.location === null ? '' : ` @ ${event.location}`;
      // The calendarId/eventId pair is what the write tools need, so it has to
      // be in the output the model reads.
      return `- ${event.summary ?? 'Untitled'} — ${when}${where}${guests} [calendarId=${event.calendarId} eventId=${event.id}]`;
    });
    return `Events between ${start} and ${end}:\n${lines.join('\n')}`;
  },
};
