import type Database from 'better-sqlite3';
import {
  GoogleAuthError,
  GoogleConflictError,
  GoogleNetworkError,
  GoogleNotFoundError,
  GoogleRateLimitError,
} from './errors';
import { refreshAccessToken } from './oauth';
import {
  clearCachedAccessToken,
  getCachedAccessToken,
  getGoogleClientConfig,
  getGoogleRefreshToken,
  setCachedAccessToken,
  setGoogleRefreshToken,
} from './token';

const API_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Safety cap on pagination. At maxResults=250 this is 12,500 events inside a
 * 240-day window -- far past any real calendar, but bounded if a nextPageToken
 * ever fails to terminate.
 * ponytail: fixed cap; parameterize only if a real calendar exceeds it.
 */
export const MAX_PAGES = 50;

export type QueryParams = Record<string, string | number | boolean>;

export interface RequestOptions {
  method?: string;
  query?: QueryParams;
  body?: unknown;
  /** Sent as If-Match so a write cannot clobber a change made elsewhere. */
  etag?: string;
}

/**
 * Returns a usable access token, refreshing through the refresh token when the
 * cached one is missing or near expiry. Access tokens are never persisted.
 */
export async function getAccessToken(db: Database.Database): Promise<string> {
  const cached = getCachedAccessToken();
  if (cached !== null) return cached;

  const config = getGoogleClientConfig(db);
  const refreshToken = getGoogleRefreshToken(db);
  if (config === null || refreshToken === null) {
    throw new GoogleAuthError('Google Calendar is not connected.');
  }

  const tokens = await refreshAccessToken(config, refreshToken);
  setCachedAccessToken(tokens.accessToken, tokens.expiresIn);
  // Google usually omits this on refresh, but when it does rotate the token,
  // failing to store the new one strands the app on a dead credential.
  if (tokens.refreshToken !== null) setGoogleRefreshToken(db, tokens.refreshToken);
  return tokens.accessToken;
}

function buildUrl(path: string, query: QueryParams = {}): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isRateLimitBody(body: string): boolean {
  return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body);
}

export async function googleRequest<T>(
  db: Database.Database,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  const token = await getAccessToken(db);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.etag !== undefined) headers['If-Match'] = options.etag;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google.');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      // Whatever we were holding is not acceptable to Google; keeping it
      // guarantees the next request fails the same way.
      clearCachedAccessToken();
      throw new GoogleAuthError('Google rejected the access token.');
    }
    if (response.status === 429) throw new GoogleRateLimitError();
    if (response.status === 403) {
      // 403 covers both throttling and genuine permission failures, and only
      // the body distinguishes them.
      if (isRateLimitBody(body)) throw new GoogleRateLimitError();
      throw new GoogleNetworkError(`Google returned 403: ${body.slice(0, 200)}`);
    }
    if (response.status === 404 || response.status === 410) throw new GoogleNotFoundError();
    if (response.status === 412) throw new GoogleConflictError();
    throw new GoogleNetworkError(`Google returned ${response.status}.`);
  }

  // DELETE returns 204 with an empty body; JSON.parse('') would throw.
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  return JSON.parse(text) as T;
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

/**
 * Fetch every page of a list endpoint SERIALLY, carrying the original query
 * forward on each page. Must never become a parallel fan-out.
 */
export async function googleFetchAll<T>(
  db: Database.Database,
  path: string,
  query: QueryParams = {}
): Promise<T[]> {
  const results: T[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageQuery: QueryParams = pageToken === undefined ? query : { ...query, pageToken };
    const response = await googleRequest<ListResponse<T>>(db, path, { query: pageQuery });
    if (response === null) break;
    if (Array.isArray(response.items)) results.push(...response.items);
    if (response.nextPageToken === undefined) break;
    pageToken = response.nextPageToken;
  }

  return results;
}
