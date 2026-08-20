import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

async function makeDb(): Promise<Database.Database> {
  const { setGoogleClientConfig, setGoogleRefreshToken, clearCachedAccessToken } = await import('./token');
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  setGoogleClientConfig(db, 'client-123', 'secret-abc');
  setGoogleRefreshToken(db, 'rt-1');
  clearCachedAccessToken();
  return db;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN_OK = { access_token: 'at-1', expires_in: 3599 };

beforeEach(async () => {
  const { clearCachedAccessToken } = await import('./token');
  clearCachedAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAccessToken', () => {
  it('refreshes once and then serves the cached token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TOKEN_OK));
    vi.stubGlobal('fetch', fetchMock);

    const { getAccessToken } = await import('./client');
    const db = await makeDb();

    expect(await getAccessToken(db)).toBe('at-1');
    expect(await getAccessToken(db)).toBe('at-1');
    // One network round trip, not two -- the cache is the whole point.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists a rotated refresh token when Google sends one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ...TOKEN_OK, refresh_token: 'rt-2' }))
    );

    const { getAccessToken } = await import('./client');
    const { getGoogleRefreshToken } = await import('./token');
    const db = await makeDb();

    await getAccessToken(db);
    // Dropping a rotated token would strand the app on a dead credential.
    expect(getGoogleRefreshToken(db)).toBe('rt-2');
  });

  it('throws GoogleAuthError when nothing is connected', async () => {
    const { getAccessToken } = await import('./client');
    const { GoogleAuthError } = await import('./errors');
    const db = new Database(':memory:');
    db.exec('create table settings (key text primary key, value text not null)');

    await expect(getAccessToken(db)).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe('googleRequest', () => {
  it('sends the bearer token and returns parsed JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
      .mockResolvedValueOnce(jsonResponse({ id: 'evt-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { googleRequest } = await import('./client');
    const db = await makeDb();

    const result = await googleRequest<{ id: string }>(db, '/calendars/primary/events/evt-1');
    expect(result).toEqual({ id: 'evt-1' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
  });

  it('sends If-Match when an etag is supplied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
      .mockResolvedValueOnce(jsonResponse({ id: 'evt-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { googleRequest } = await import('./client');
    const db = await makeDb();

    await googleRequest(db, '/calendars/primary/events/evt-1', {
      method: 'PUT',
      body: { summary: 'x' },
      etag: '"abc123"',
    });

    const init = fetchMock.mock.calls[1][1];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"abc123"');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ summary: 'x' }));
  });

  it('returns null for a 204 with no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
    );

    const { googleRequest } = await import('./client');
    const db = await makeDb();

    expect(await googleRequest(db, '/calendars/primary/events/evt-1', { method: 'DELETE' })).toBeNull();
  });

  it('maps 401 to GoogleAuthError and drops the cached access token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
        .mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))
    );

    const { googleRequest } = await import('./client');
    const { getCachedAccessToken } = await import('./token');
    const { GoogleAuthError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleAuthError);
    // Holding a token Google just rejected guarantees the next call fails too.
    expect(getCachedAccessToken()).toBeNull();
  });

  it('maps 403 rateLimitExceeded to GoogleRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
        .mockResolvedValueOnce(
          jsonResponse({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403)
        )
    );

    const { googleRequest } = await import('./client');
    const { GoogleRateLimitError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleRateLimitError);
  });

  it('maps 429 to GoogleRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockResolvedValueOnce(jsonResponse({}, 429))
    );

    const { googleRequest } = await import('./client');
    const { GoogleRateLimitError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleRateLimitError);
  });

  it('maps 412 to GoogleConflictError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockResolvedValueOnce(jsonResponse({}, 412))
    );

    const { googleRequest } = await import('./client');
    const { GoogleConflictError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/x', { method: 'PUT', etag: '"old"' })).rejects.toBeInstanceOf(
      GoogleConflictError
    );
  });

  it('maps 404 to GoogleNotFoundError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockResolvedValueOnce(jsonResponse({}, 404))
    );

    const { googleRequest } = await import('./client');
    const { GoogleNotFoundError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/x')).rejects.toBeInstanceOf(GoogleNotFoundError);
  });

  it('maps a thrown fetch to GoogleNetworkError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockRejectedValueOnce(new Error('offline'))
    );

    const { googleRequest } = await import('./client');
    const { GoogleNetworkError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleNetworkError);
  });
});

describe('googleFetchAll', () => {
  it('follows nextPageToken serially and concatenates items', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('https://oauth2.googleapis.com')) return Promise.resolve(jsonResponse(TOKEN_OK));
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'a' }], nextPageToken: 'page-2' }));
      }
      return Promise.resolve(jsonResponse({ items: [{ id: 'b' }] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { googleFetchAll } = await import('./client');
    const db = await makeDb();

    const items = await googleFetchAll<{ id: string }>(db, '/calendars/primary/events', {
      singleEvents: true,
    });

    expect(items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('singleEvents=true');
    expect(calls[0]).not.toContain('pageToken');
    expect(calls[1]).toContain('pageToken=page-2');
    // The second page must also carry the original query, or Google silently
    // resets the window and returns a different result set.
    expect(calls[1]).toContain('singleEvents=true');
  });

  it('stops at the page cap rather than looping forever', async () => {
    let pages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com')) return Promise.resolve(jsonResponse(TOKEN_OK));
        pages += 1;
        // A server that always returns a next token would hang the sync.
        return Promise.resolve(jsonResponse({ items: [{ id: String(pages) }], nextPageToken: 'more' }));
      })
    );

    const { googleFetchAll, MAX_PAGES } = await import('./client');
    const db = await makeDb();

    const items = await googleFetchAll<{ id: string }>(db, '/calendars/primary/events');
    expect(items).toHaveLength(MAX_PAGES);
  });
});
