import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { createCalendarEvent } from '../../calendar/writes';

export const calendarCreateEventTool: ToolDefinition = {
  name: 'calendar_create_event',
  // Baseline tier for display. The gate call below is what enforces, and it
  // escalates to CONSEQUENTIAL when other people are invited.
  tier: 'SAFE_WRITE',
  label: 'Create a calendar event',
  schema: {
    name: 'calendar_create_event',
    description:
      "Create an event on one of the user's Google Calendars. Use calendar_list_events first to check for conflicts. Times are RFC3339 timestamps for timed events, or YYYY-MM-DD dates when allDay is true.",
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar to add to. Use the primary calendar unless told otherwise.' },
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'RFC3339 start, or YYYY-MM-DD when allDay is true.' },
        end: { type: 'string', description: 'RFC3339 end, or the exclusive YYYY-MM-DD end date when allDay is true.' },
        allDay: { type: 'boolean', description: 'True for an all-day event. Defaults to false.' },
        location: { type: 'string', description: 'Optional location.' },
        description: { type: 'string', description: 'Optional notes.' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional guest email addresses. Adding any will email those people.',
        },
      },
      required: ['calendarId', 'summary', 'start', 'end'],
    },
  },
  async run(input, ctx) {
    const attendees = Array.isArray(input.attendees) ? (input.attendees as string[]) : [];
    const summary = String(input.summary ?? '');
    const start = String(input.start ?? '');

    // Escalation happens at call time: inviting real people is outward-facing
    // and cannot be unsent, unlike adding a solo block to your own calendar.
    const tier = attendees.length > 0 ? 'CONSEQUENTIAL' : 'SAFE_WRITE';
    const guestNote = attendees.length > 0 ? ` ${attendees.length} guests will be invited by email.` : '';
    const approved = await gate(
      tier,
      ctx.mode,
      'calendar_create_event',
      `Create "${summary}" starting ${start}.${guestNote}`,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so no event was created.';

    const result = await createCalendarEvent(ctx.db, {
      calendarId: String(input.calendarId ?? ''),
      summary,
      startAt: start,
      endAt: String(input.end ?? ''),
      isAllDay: input.allDay === true,
      location: typeof input.location === 'string' ? input.location : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
    });

    return result.ok ? `Created "${summary}".` : `Could not create the event: ${result.error ?? 'unknown error'}`;
  },
};
