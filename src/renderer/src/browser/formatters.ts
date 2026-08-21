const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Electron reports 0 or a negative total for a chunked response with no
 * Content-Length. Rendering that as "0 B" would tell the user a large download
 * is empty, so unknown is stated as unknown.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
