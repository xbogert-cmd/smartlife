import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getEvent } from '../../calendar/queries';
import { deleteCalendarEvent } from '../../calendar/writes';

export const calendarDeleteEventTool: ToolDefinition = {
  name: 'calendar_delete_event',
  // Always CONSEQUENTIAL: a deletion destroys data and, when the event has
  // attendees, sends everyone a cancellation.
  tier: 'CONSEQUENTIAL',
  label: 'Delete a calendar event',
  schema: {
    name: 'calendar_delete_event',
    description:
      'Delete a calendar event. Get calendarId and eventId from calendar_list_events. This cannot be undone from within SmartLife.',
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar the event lives on.' },
        eventId: { type: 'string', description: 'Event to delete.' },
      },
      required: ['calendarId', 'eventId'],
    },
  },
  async run(input, ctx) {
    const calendarId = String(input.calendarId ?? '');
    const eventId = String(input.eventId ?? '');
    const existing = getEvent(ctx.db, calendarId, eventId);
    if (existing === null) {
      return `No event found with id ${eventId} on calendar ${calendarId}. Nothing was deleted.`;
    }

    const guestNote = existing.hasGuests
      ? ` ${existing.guestCount} guests will be notified by email.`
      : '';
    const approved = await gate(
      'CONSEQUENTIAL',
      ctx.mode,
      'calendar_delete_event',
      `Delete "${existing.summary ?? 'Untitled'}" — ${existing.startAt}.${guestNote}`,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so nothing was deleted.';

    const result = await deleteCalendarEvent(ctx.db, calendarId, eventId);
    return result.ok
      ? `Deleted "${existing.summary ?? 'Untitled'}".`
      : `Could not delete the event: ${result.error ?? 'unknown error'}`;
  },
};
