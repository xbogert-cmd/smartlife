/**
 * Policy for embedded web content. Deliberately pure: no Electron import, no
 * session handle, no I/O -- so every rule here is directly testable under
 * ELECTRON_RUN_AS_NODE with no BrowserWindow in sight. view.ts and
 * downloads.ts wire these decisions to the real session.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Allowlist, not blocklist. `file:` is the one that matters most -- a page
 * navigating to file:///Users/... has no legitimate purpose inside this app --
 * but data:, blob: and javascript: are all standard top-level spoofing and
 * injection vectors, and a blocklist would miss whatever scheme comes next.
 */
export function isAllowedNavigationUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.toLowerCase() === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}

/**
 * Every permission Electron currently surfaces through
 * setPermissionRequestHandler / setPermissionCheckHandler. The list exists so
 * the test can iterate it; shouldAllowPermission does not consult it, because
 * an unknown permission must be denied too.
 */
export const DENIED_PERMISSIONS: readonly string[] = [
  'media',
  'mediaKeySystem',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'pointerLock',
  'fullscreen',
  'display-capture',
  'clipboard-read',
  'clipboard-sanitized-write',
  'idle-detection',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'openExternal',
  'window-management',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
];

/**
 * Deny everything, including permissions that do not exist yet. Guessing an
 * allowlist up front would be inventing requirements; view.ts logs each denial
 * instead, so if something genuinely breaks there is evidence rather than a
 * theory.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shouldAllowPermission(_permission: string): boolean {
  return false;
}

const FALLBACK_FILENAME = 'download';
const MAX_FILENAME_LENGTH = 255;

/**
 * C0 control characters plus DEL. Built from a string with escaped backslashes
 * rather than a regex literal so no literal control byte ever appears in this
 * source file.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/**
 * The download filename is chosen by the remote server (Content-Disposition or
 * the URL path) and is therefore attacker-controlled. Take only the basename,
 * then strip anything that could still escape the target directory or confuse
 * the filesystem.
 */
export function sanitizeDownloadFilename(raw: string): string {
  const lastSeparator = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const base = lastSeparator === -1 ? raw : raw.slice(lastSeparator + 1);
  const cleaned = base
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned.length === 0) return FALLBACK_FILENAME;
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}
