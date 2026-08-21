/**
 * Turns whatever the user typed into the address bar into a URL to navigate
 * to. Pure: no Electron, no network, no settings lookup.
 *
 * DuckDuckGo is the search engine, chosen deliberately -- no account, no
 * tracking, and no configuration surface to build. If it ever needs to be
 * user-configurable it becomes a settings value; today it is a constant.
 */
export const SEARCH_URL_PREFIX = 'https://duckduckgo.com/?q=';

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const DOTTED_QUAD = /^(\d{1,3}\.){3}\d{1,3}$/;
const ONLY_DIGITS_AND_DOTS = /^[\d.]+$/;

function hostOf(value: string): string {
  return value.split(/[/?#]/)[0];
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

function isLoopbackHost(host: string): boolean {
  const bare = stripPort(host);
  return bare === 'localhost' || bare === '127.0.0.1';
}

/**
 * "Looks like somewhere to go", not "is a valid hostname". The cost of a wrong
 * guess is a search instead of a navigation, so err toward searching.
 */
function isHostShaped(value: string): boolean {
  if (/\s/.test(value)) return false;
  const host = hostOf(value);
  if (host.length === 0) return false;
  if (host.includes('@')) return false;
  if (isLoopbackHost(host)) return true;
  if (!host.includes('.')) return false;
  if (host.endsWith('.')) return false;
  // "3.5" and "1.2.3" are far likelier to be search terms than hosts. A real
  // dotted-quad address still resolves as a host.
  const bare = stripPort(host);
  if (ONLY_DIGITS_AND_DOTS.test(bare) && !DOTTED_QUAD.test(bare)) return false;
  return true;
}

export function resolveAddressInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 'about:blank';
  if (trimmed.toLowerCase() === 'about:blank') return 'about:blank';
  if (SCHEME_PATTERN.test(trimmed)) return trimmed;
  if (isHostShaped(trimmed)) {
    const scheme = isLoopbackHost(hostOf(trimmed)) ? 'http' : 'https';
    return `${scheme}://${trimmed}`;
  }
  return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
}
