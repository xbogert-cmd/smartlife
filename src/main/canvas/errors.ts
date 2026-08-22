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

/**
 * A 403 that is neither auth nor throttling. Extends CanvasNetworkError on
 * purpose: sync.ts already catches that for instructor-disabled Files tabs,
 * and client.test.ts asserts it. Carries the body so callers can explain the
 * refusal rather than printing a bare status.
 */
export class CanvasForbiddenError extends CanvasNetworkError {
  readonly body: string;

  constructor(body: string) {
    super(`Canvas returned 403: ${body.slice(0, 200)}`);
    this.name = 'CanvasForbiddenError';
    this.body = body;
  }
}

/**
 * Canvas returns 403 with the literal body `require_initial_post` when a
 * discussion thread is read before the user has posted to it. Not a
 * permissions problem — a sequencing one, and the fix is to post first.
 */
export class CanvasRequireInitialPostError extends CanvasForbiddenError {
  constructor(body = 'require_initial_post') {
    super(body);
    this.name = 'CanvasRequireInitialPostError';
  }
}
