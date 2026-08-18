// Canvas serves announcement and page images from the institution's host.
// Without this, `default-src 'self'` silently blocks every embedded image.
const CANVAS_IMG = "img-src 'self' data: https://*.instructure.com";

export function buildCsp(isDev: boolean): string {
  if (isDev) {
    return (
      "default-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      `${CANVAS_IMG}; ` +
      "connect-src 'self' ws://localhost:*"
    );
  }
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ${CANVAS_IMG}`;
}
