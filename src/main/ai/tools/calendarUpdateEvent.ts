import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getEvent } from '../../calendar/queries';
import { updateCalendarEvent } from '../../calendar/writes';

export const calendarUpdateEventTool: ToolDefinition = {
  name: 'calendar_update_event',
  tier: 'SAFE_WRITE',
  label: 'Update a calendar event',
  schema: {
    name: 'calendar_update_event',
    description:
      'Change an existing calendar event — its title, time, location, or notes. Get calendarId and eventId from calendar_list_events. This replaces the event, so pass every field you want kept.',
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar the event lives on.' },
        eventId: { type: 'string', description: 'Event to change.' },
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'RFC3339 start, or YYYY-MM-DD when allDay is true.' },
        end: { type: 'string', description: 'RFC3339 end, or the exclusive YYYY-MM-DD end date when allDay is true.' },
        allDay: { type: 'boolean', description: 'True for an all-day event. Defaults to false.' },
        location: { type: 'string', description: 'Optional location.' },
        description: { type: 'string', description: 'Optional notes.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Optional guest email addresses.' },
      },
      required: ['calendarId', 'eventId', 'summary', 'start', 'end'],
    },
  },
  async run(input, ctx) {
    const calendarId = String(input.calendarId ?? '');
    const eventId = String(input.eventId ?? '');
    const existing = getEvent(ctx.db, calendarId, eventId);
    if (existing === null) {
      return `No event found with id ${eventId} on calendar ${calendarId}. Use calendar_list_events to find it.`;
    }

    const attendees = Array.isArray(input.attendees) ? (input.attendees as string[]) : [];
    const summary = String(input.summary ?? '');
    const start = String(input.start ?? '');

    // The STORED event's guests matter as much as the input's: moving an
    // existing meeting emails its attendees whether or not this call mentions
    // them.
    const guestCount = Math.max(existing.guestCount, attendees.length);
    const hasGuests = existing.hasGuests || attendees.length > 0;
    const tier = hasGuests ? 'CONSEQUENTIAL' : 'SAFE_WRITE';
    const guestNote = hasGuests ? ` ${guestCount} guests will be notified by email.` : '';

    const approved = await gate(
      tier,
      ctx.mode,
      'calendar_update_event',
      `Change "${existing.summary ?? 'Untitled'}" to "${summary}" starting ${start}.${guestNote}`,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so the event was left unchanged.';

    const result = await updateCalendarEvent(ctx.db, eventId, {
      calendarId,
      summary,
      startAt: start,
      endAt: String(input.end ?? ''),
      isAllDay: input.allDay === true,
      location: typeof input.location === 'string' ? input.location : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
    });

    return result.ok ? `Updated "${summary}".` : `Could not update the event: ${result.error ?? 'unknown error'}`;
  },
};
