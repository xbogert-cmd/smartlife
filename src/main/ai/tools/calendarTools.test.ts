import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('../../calendar/writes', () => ({
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));

import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '../../calendar/writes';
import { calendarCreateEventTool } from './calendarCreateEvent';
import { calendarDeleteEventTool } from './calendarDeleteEvent';
import { calendarListEventsTool } from './calendarListEvents';
import { calendarUpdateEventTool } from './calendarUpdateEvent';
import type { AiMode } from '../permissions';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
  `);
  db.prepare("insert into google_calendars (id, summary, is_primary) values ('cal-1','Personal',1)").run();
  return db;
}

function seedEvent(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  db.prepare(
    `insert into google_events (calendar_id, id, summary, start_at, end_at, has_guests, guest_count)
     values (@calendar_id, @id, @summary, @start_at, @end_at, @has_guests, @guest_count)`
  ).run({
    calendar_id: 'cal-1',
    id: 'evt-1',
    summary: 'Group project sync',
    start_at: '2026-08-27T18:00:00.000Z',
    end_at: '2026-08-27T19:00:00.000Z',
    has_guests: 0,
    guest_count: 0,
    ...overrides,
  });
}

function ctx(db: Database.Database, mode: AiMode, requestConfirmation = vi.fn().mockResolvedValue(true)) {
  return { db, conversationId: 'c1', mode, requestConfirmation };
}

beforeEach(() => {
  vi.mocked(createCalendarEvent).mockReset().mockResolvedValue({ ok: true, eventId: 'new-1' } as never);
  vi.mocked(updateCalendarEvent).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(deleteCalendarEvent).mockReset().mockResolvedValue({ ok: true } as never);
});

describe('calendar_list_events', () => {
  it('is READ tier', () => {
    expect(calendarListEventsTool.tier).toBe('READ');
  });

  it('reads local data without ever asking for confirmation', async () => {
    const db = makeDb();
    seedEvent(db);
    const requestConfirmation = vi.fn();

    const output = await calendarListEventsTool.run(
      { start: '2026-08-24', end: '2026-08-30' },
      ctx(db, 'ask', requestConfirmation)
    );

    expect(output).toContain('Group project sync');
    // READ tools must never pause, even in ask mode.
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('says so plainly when nothing is scheduled', async () => {
    const output = await calendarListEventsTool.run(
      { start: '2026-08-24', end: '2026-08-30' },
      ctx(makeDb(), 'ask')
    );
    expect(output).toMatch(/nothing/i);
  });
});

describe('calendar_create_event', () => {
  it('does not pause in assist mode for a solo event', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarCreateEventTool.run(
      {
        calendarId: 'cal-1',
        summary: 'Study block',
        start: '2026-08-27T18:00:00.000Z',
        end: '2026-08-27T20:00:00.000Z',
      },
      ctx(makeDb(), 'assist', requestConfirmation)
    );

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
  });

  it('pauses in assist mode when attendees are named', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarCreateEventTool.run(
      {
        calendarId: 'cal-1',
        summary: 'Group sync',
        start: '2026-08-27T18:00:00.000Z',
        end: '2026-08-27T19:00:00.000Z',
        attendees: ['a@example.com', 'b@example.com'],
      },
      ctx(makeDb(), 'assist', requestConfirmation)
    );

    // Inviting real people is outward-facing and cannot be unsent.
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const description = requestConfirmation.mock.calls[0][1] as string;
    expect(description).toContain('Group sync');
    expect(description).toContain('2 guests');
  });

  it('pauses in ask mode even for a solo event', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarCreateEventTool.run(
      { calendarId: 'cal-1', summary: 'Study block', start: '2026-08-27T18:00:00.000Z', end: '2026-08-27T20:00:00.000Z' },
      ctx(makeDb(), 'ask', requestConfirmation)
    );

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the user declines', async () => {
    const output = await calendarCreateEventTool.run(
      { calendarId: 'cal-1', summary: 'Study block', start: '2026-08-27T18:00:00.000Z', end: '2026-08-27T20:00:00.000Z' },
      ctx(makeDb(), 'ask', vi.fn().mockResolvedValue(false))
    );

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(output).toMatch(/declin|cancel/i);
  });

  it('reports a write failure back to the model', async () => {
    vi.mocked(createCalendarEvent).mockResolvedValue({ ok: false, error: "You're offline — this change wasn't saved." } as never);

    const output = await calendarCreateEventTool.run(
      { calendarId: 'cal-1', summary: 'x', start: '2026-08-27T18:00:00.000Z', end: '2026-08-27T19:00:00.000Z' },
      ctx(makeDb(), 'auto')
    );

    expect(output).toContain('offline');
  });
});

describe('calendar_update_event', () => {
  it('escalates when the STORED event has guests, even if the input does not', async () => {
    const db = makeDb();
    seedEvent(db, { has_guests: 1, guest_count: 3 });
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarUpdateEventTool.run(
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        summary: 'Group project sync',
        start: '2026-08-28T18:00:00.000Z',
        end: '2026-08-28T19:00:00.000Z',
      },
      ctx(db, 'assist', requestConfirmation)
    );

    // Moving an existing meeting emails its attendees whether or not the tool
    // input mentions them.
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0][1]).toContain('3 guests');
  });

  it('does not pause in assist mode for a solo event', async () => {
    const db = makeDb();
    seedEvent(db);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarUpdateEventTool.run(
      { calendarId: 'cal-1', eventId: 'evt-1', summary: 'Renamed', start: '2026-08-28T18:00:00.000Z', end: '2026-08-28T19:00:00.000Z' },
      ctx(db, 'assist', requestConfirmation)
    );

    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('fails cleanly when the event is unknown', async () => {
    const output = await calendarUpdateEventTool.run(
      { calendarId: 'cal-1', eventId: 'ghost', summary: 'x', start: '2026-08-28T18:00:00.000Z', end: '2026-08-28T19:00:00.000Z' },
      ctx(makeDb(), 'auto')
    );

    expect(output).toMatch(/not found|no event/i);
    expect(updateCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('calendar_delete_event', () => {
  it('is CONSEQUENTIAL and pauses even in assist mode for a solo event', async () => {
    const db = makeDb();
    seedEvent(db);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    expect(calendarDeleteEventTool.tier).toBe('CONSEQUENTIAL');
    await calendarDeleteEventTool.run({ calendarId: 'cal-1', eventId: 'evt-1' }, ctx(db, 'assist', requestConfirmation));

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('names the event and its guests in the confirmation', async () => {
    const db = makeDb();
    seedEvent(db, { has_guests: 1, guest_count: 3 });
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarDeleteEventTool.run({ calendarId: 'cal-1', eventId: 'evt-1' }, ctx(db, 'ask', requestConfirmation));

    const description = requestConfirmation.mock.calls[0][1] as string;
    // A confirmation that does not say what will happen is a rubber stamp.
    expect(description).toContain('Group project sync');
    expect(description).toContain('3 guests');
  });

  it('deletes nothing when declined', async () => {
    const db = makeDb();
    seedEvent(db);

    await calendarDeleteEventTool.run(
      { calendarId: 'cal-1', eventId: 'evt-1' },
      ctx(db, 'ask', vi.fn().mockResolvedValue(false))
    );

    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('registry', () => {
  it('registers all four calendar tools', async () => {
    const { TOOLS } = await import('./registry');
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('calendar_list_events');
    expect(names).toContain('calendar_create_event');
    expect(names).toContain('calendar_update_event');
    expect(names).toContain('calendar_delete_event');
  });
});
