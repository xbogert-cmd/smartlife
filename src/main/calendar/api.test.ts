import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return {
    ...actual,
    googleRequest: vi.fn(),
  };
});

import { googleRequest } from './client';
import { createEvent, deleteEvent, updateEvent } from './api';
import type { GoogleEventInput } from './api';
import type { RequestOptions } from './client';

function makeDb(): Database.Database {
  return new Database(':memory:');
}

const EVENT_INPUT: GoogleEventInput = {
  summary: 'Test',
  start: { dateTime: '2026-08-21T14:00:00.000Z' },
  end: { dateTime: '2026-08-21T15:00:00.000Z' },
};

beforeEach(() => {
  vi.mocked(googleRequest).mockReset();
});

function optionsOf(callIndex = 0): RequestOptions {
  return vi.mocked(googleRequest).mock.calls[callIndex][2] as RequestOptions;
}

describe('updateEvent', () => {
  it('uses PATCH, not PUT, so fields omitted from the draft are preserved rather than cleared', async () => {
    vi.mocked(googleRequest).mockResolvedValue({ id: 'evt-1' } as never);

    await updateEvent(makeDb(), 'cal-1', 'evt-1', EVENT_INPUT, '"etag-1"');

    // events.update (PUT) replaces the whole resource -- any field this app
    // doesn't send (attendees, description, conference data) gets cleared on
    // Google's side. events.patch (PATCH) is a genuine partial update.
    expect(optionsOf().method).toBe('PATCH');
  });

  it('still sends the etag as If-Match under PATCH', async () => {
    vi.mocked(googleRequest).mockResolvedValue({ id: 'evt-1' } as never);

    await updateEvent(makeDb(), 'cal-1', 'evt-1', EVENT_INPUT, '"etag-1"');

    expect(optionsOf().etag).toBe('"etag-1"');
  });

  it('sets sendUpdates=all so the confirmation prompt about emailing guests is true', async () => {
    vi.mocked(googleRequest).mockResolvedValue({ id: 'evt-1' } as never);

    await updateEvent(makeDb(), 'cal-1', 'evt-1', EVENT_INPUT);

    expect(optionsOf().query?.sendUpdates).toBe('all');
  });
});

describe('createEvent', () => {
  it('sets sendUpdates=all', async () => {
    vi.mocked(googleRequest).mockResolvedValue({ id: 'evt-1' } as never);

    await createEvent(makeDb(), 'cal-1', EVENT_INPUT);

    expect(optionsOf().query?.sendUpdates).toBe('all');
  });
});

describe('deleteEvent', () => {
  it('sets sendUpdates=all', async () => {
    vi.mocked(googleRequest).mockResolvedValue(null as never);

    await deleteEvent(makeDb(), 'cal-1', 'evt-1');

    expect(optionsOf().query?.sendUpdates).toBe('all');
  });
});
