export function buildCsp(isDev: boolean): string {
  if (isDev) {
    return (
      "default-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws://localhost:*"
    );
  }
  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
}
