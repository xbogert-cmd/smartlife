/** The token is missing, revoked, or expired. Routine — UNCW caps tokens at 90 days. */
export class CanvasAuthError extends Error {
  constructor(message = 'Canvas rejected the access token.') {
    super(message);
    this.name = 'CanvasAuthError';
  }
}

/** Canvas throttled the request. Back off; do not retry immediately. */
export class CanvasRateLimitError extends Error {
  constructor(message = 'Canvas is rate limiting requests.') {
    super(message);
    this.name = 'CanvasRateLimitError';
  }
}

/** Offline, DNS failure, 5xx, or any other unexpected HTTP status. */
export class CanvasNetworkError extends Error {
  constructor(message = 'Could not reach Canvas.') {
    super(message);
    this.name = 'CanvasNetworkError';
  }
}
