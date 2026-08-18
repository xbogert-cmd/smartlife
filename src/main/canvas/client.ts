import { CanvasAuthError, CanvasNetworkError, CanvasRateLimitError } from './errors';

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
    throw new CanvasNetworkError(`Canvas returned 403: ${body.slice(0, 200)}`);
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
