import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasFetchAll, canvasFetchOne, parseNextLink } from './client';
import { CanvasAuthError, CanvasNetworkError, CanvasRateLimitError } from './errors';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.link) headers.set('link', init.link);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseNextLink', () => {
  it('returns null when there is no header', () => {
    expect(parseNextLink(null)).toBeNull();
  });

  it('extracts the next URL from a multi-rel header', () => {
    const header =
      '<https://x/api/v1/courses?page=1>; rel="current",' +
      '<https://x/api/v1/courses?page=2>; rel="next",' +
      '<https://x/api/v1/courses?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe('https://x/api/v1/courses?page=2');
  });

  it('returns null when only prev and current are present', () => {
    const header = '<https://x/a?page=1>; rel="current",<https://x/a?page=0>; rel="prev"';
    expect(parseNextLink(header)).toBeNull();
  });
});

describe('canvasFetchAll', () => {
  it('sends the bearer token and forces per_page=100', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 1 }]));
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://uncw.instructure.com/api/v1/courses');
    expect(url).toContain('per_page=100');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('expands array params into repeated keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses', { 'include[]': ['total_scores', 'term'] });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('include%5B%5D=total_scores');
    expect(url).toContain('include%5B%5D=term');
  });

  it('follows Link rel=next across pages and concatenates results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], { link: '<https://uncw.instructure.com/p2>; rel="next"' })
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: 2 }], { link: '<https://uncw.instructure.com/p3>; rel="next"' })
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }]));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await canvasFetchAll<{ id: number }>(CREDS, '/api/v1/courses');

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('https://uncw.instructure.com/p2');
  });

  it('requests pages one at a time rather than in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return url.includes('p2')
        ? jsonResponse([{ id: 2 }])
        : jsonResponse([{ id: 1 }], { link: '<https://uncw.instructure.com/p2>; rel="next"' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses');

    expect(maxInFlight).toBe(1);
  });

  it('stops after the page cap even if Canvas keeps advertising next', async () => {
    // mockImplementation (not mockResolvedValue) so each of the 50 calls gets
    // its own Response instance — a Fetch Response body can only be read once,
    // and this loop calls .json() on every page.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse([{ id: 1 }], { link: '<https://uncw.instructure.com/p>; rel="next"' })
      );
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses');

    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it('maps 401 to CanvasAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ errors: [] }, { status: 401 })));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasAuthError);
  });

  it('maps 429 to CanvasRateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 429 })));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasRateLimitError);
  });

  it('maps a 403 rate-limit body to CanvasRateLimitError, not an auth error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('403 Forbidden (Rate Limit Exceeded)', { status: 403 }))
    );
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasRateLimitError);
  });

  it('maps a plain 403 to CanvasNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasNetworkError);
  });

  it('maps a thrown fetch (offline) to CanvasNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasNetworkError);
  });
});

describe('canvasFetchOne', () => {
  it('returns the single object without pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, name: 'Ada' }));
    vi.stubGlobal('fetch', fetchMock);

    const user = await canvasFetchOne<{ id: number; name: string }>(CREDS, '/api/v1/users/self');

    expect(user.name).toBe('Ada');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to CanvasAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 })));
    await expect(canvasFetchOne(CREDS, '/api/v1/users/self')).rejects.toBeInstanceOf(CanvasAuthError);
  });
});
