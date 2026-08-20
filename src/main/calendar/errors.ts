/** The refresh token is revoked, expired, or the grant was withdrawn. Routine. */
export class GoogleAuthError extends Error {
  constructor(message = 'Google rejected the credentials.') {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Google throttled the request. Back off; do not retry immediately. */
export class GoogleRateLimitError extends Error {
  constructor(message = 'Google is rate limiting requests.') {
    super(message);
    this.name = 'GoogleRateLimitError';
  }
}

/**
 * The event changed elsewhere since we last synced it (etag mismatch on an
 * If-Match write). The caller must resync and let the user retry rather than
 * blindly overwriting whatever the other client wrote.
 */
export class GoogleConflictError extends Error {
  constructor(message = 'This event was changed somewhere else.') {
    super(message);
    this.name = 'GoogleConflictError';
  }
}

/**
 * The event or calendar no longer exists on Google's side. For a delete this
 * is effectively success; for an update the user needs to be told.
 */
export class GoogleNotFoundError extends Error {
  constructor(message = 'That event no longer exists on Google Calendar.') {
    super(message);
    this.name = 'GoogleNotFoundError';
  }
}

/** Offline, DNS failure, 5xx, or any other unexpected HTTP status. */
export class GoogleNetworkError extends Error {
  constructor(message = 'Could not reach Google.') {
    super(message);
    this.name = 'GoogleNetworkError';
  }
}
