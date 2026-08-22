import {
  CanvasAuthError,
  CanvasForbiddenError,
  CanvasNetworkError,
  CanvasRateLimitError,
  CanvasRequireInitialPostError,
} from './errors';

export interface CanvasCredentials {
  baseUrl: string;
  token: string;
}

export type QueryParams = Record<string, string | number | string[]>;

/**
 * Safety cap on pagination. Canvas pages at 100/request here, so 50 pages is
 * 5000 rows — far beyond any real course list, but bounded if a malformed
 * Link header ever points at itself.
 * ponytail: fixed cap; make it a parameter only if a real dataset exceeds it.
 */
const MAX_PAGES = 50;

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (match) return match[1];
  }
  return null;
}

function buildUrl(baseUrl: string, path: string, params: QueryParams): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

async function requestPage(url: string, token: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (error) {
    throw new CanvasNetworkError(error instanceof Error ? error.message : 'Could not reach Canvas.');
  }

  if (response.ok) return response;

  if (response.status === 401) {
    throw new CanvasAuthError();
  }
  if (response.status === 429) {
    throw new CanvasRateLimitError();
  }
  // Canvas has historically signalled throttling as a 403 with this body.
  if (response.status === 403) {
    const body = await response.text().catch(() => '');
    if (/rate limit/i.test(body)) throw new CanvasRateLimitError();
    // Canvas returns the bare string for a thread read before an initial post.
    if (body.trim() === 'require_initial_post') throw new CanvasRequireInitialPostError(body.trim());
    throw new CanvasForbiddenError(body);
  }
  throw new CanvasNetworkError(`Canvas returned ${response.status}.`);
}

/**
 * Fetch every page of a list endpoint, following Link rel="next" SERIALLY.
 * Instructure explicitly advises against concurrent requests, so this must
 * never be converted to a parallel fan-out.
 */
export async function canvasFetchAll<T>(
  creds: CanvasCredentials,
  path: string,
  params: QueryParams = {}
): Promise<T[]> {
  let url: string | null = buildUrl(creds.baseUrl, path, { per_page: 100, ...params });
  const results: T[] = [];

  for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
    const response = await requestPage(url, creds.token);
    const batch = (await response.json()) as T[];
    if (Array.isArray(batch)) results.push(...batch);
    url = parseNextLink(response.headers.get('link'));
  }

  return results;
}

export async function canvasFetchOne<T>(
  creds: CanvasCredentials,
  path: string,
  params: QueryParams = {}
): Promise<T> {
  const response = await requestPage(buildUrl(creds.baseUrl, path, params), creds.token);
  return (await response.json()) as T;
}

/**
 * Canvas accepts JSON bodies on its write endpoints, which keeps nested
 * params (`submission[submission_type]`) expressible as plain objects instead
 * of hand-rolled form encoding. Shares requestPage's error mapping, so a POST
 * and a GET fail identically.
 */
export async function canvasPost<T>(
  creds: CanvasCredentials,
  path: string,
  body: unknown
): Promise<T> {
  const url = new URL(path, creds.baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new CanvasNetworkError(error instanceof Error ? error.message : 'Could not reach Canvas.');
  }

  if (!response.ok) {
    if (response.status === 401) throw new CanvasAuthError();
    if (response.status === 429) throw new CanvasRateLimitError();
    if (response.status === 403) {
      const text = await response.text().catch(() => '');
      if (/rate limit/i.test(text)) throw new CanvasRateLimitError();
      if (text.trim() === 'require_initial_post') throw new CanvasRequireInitialPostError(text.trim());
      throw new CanvasForbiddenError(text);
    }
    const text = await response.text().catch(() => '');
    throw new CanvasNetworkError(`Canvas returned ${response.status}: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as T;
}
