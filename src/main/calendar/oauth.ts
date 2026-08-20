import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleAuthError, GoogleNetworkError } from './errors';
import type { GoogleClientConfig } from './token';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Read plus write. The readonly scope cannot satisfy this phase's CRUD. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Abandon the flow if the user never finishes in their browser. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes -> 43 base64url chars, the RFC 7636 minimum.
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // access_type=offline is what makes Google issue a refresh token at all;
  // prompt=consent forces it to reissue one on every re-authorization rather
  // than only the first.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    throw new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google.');
  }

  const text = await response.text();
  if (!response.ok) {
    // 400 invalid_grant is the ordinary "revoked or expired" signal; 401 is a
    // bad client. Both mean the user has to reconnect, so both are auth errors.
    if (response.status === 400 || response.status === 401) {
      throw new GoogleAuthError(`Google rejected the credentials: ${text.slice(0, 200)}`);
    }
    throw new GoogleNetworkError(`Google returned ${response.status}.`);
  }

  const parsed = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!parsed.access_token) {
    throw new GoogleAuthError('Google returned no access token.');
  }
  return {
    accessToken: parsed.access_token,
    // Refresh responses legitimately omit this; only the initial exchange
    // carries one.
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: parsed.expires_in ?? 3600,
  };
}

export function exchangeCodeForTokens(
  config: GoogleClientConfig,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    })
  );
}

export function refreshAccessToken(
  config: GoogleClientConfig,
  refreshToken: string
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
  );
}

function respond(res: ServerResponse, message: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center">
      <h2>${message}</h2><p>You can close this tab and return to SmartLife.</p>
    </body></html>`
  );
}

/**
 * Runs the full loopback flow: start a one-shot server on an OS-assigned port,
 * open the system browser, and resolve once Google redirects back.
 *
 * Binding 127.0.0.1 (never 0.0.0.0), verifying `state`, and shutting down after
 * a single request are what stop another local process from reaching this port
 * and injecting its own authorization code.
 */
export function runOAuthFlow(
  config: GoogleClientConfig,
  openBrowser: (url: string) => void
): Promise<TokenResponse> {
  const { verifier, challenge } = generatePkcePair();
  const state = base64Url(randomBytes(16));

  return new Promise<TokenResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (returnedState !== state) {
        respond(res, 'Sign-in could not be verified.');
        finish(null, new GoogleAuthError('The sign-in response could not be verified.'));
        return;
      }
      if (error !== null || code === null) {
        respond(res, 'Sign-in was cancelled.');
        finish(null, new GoogleAuthError(`Google returned "${error ?? 'no code'}".`));
        return;
      }

      respond(res, 'SmartLife is connected.');
      const redirectUri = redirectUriFor(server.address() as AddressInfo);
      exchangeCodeForTokens(config, code, redirectUri, verifier).then(
        (tokens) => finish(tokens, null),
        (err: unknown) => finish(null, err)
      );
    });

    function finish(tokens: TokenResponse | null, error: unknown): void {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      server.close();
      if (error !== null) reject(error);
      else resolve(tokens as TokenResponse);
    }

    server.on('error', (err) => finish(null, new GoogleNetworkError(err.message)));

    // Port 0 asks the OS for any free port; 127.0.0.1 keeps it off the network.
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = redirectUriFor(server.address() as AddressInfo);
      timer = setTimeout(
        () => finish(null, new GoogleAuthError('Sign-in timed out.')),
        FLOW_TIMEOUT_MS
      );
      openBrowser(buildAuthUrl(config.clientId, redirectUri, challenge, state));
    });
  });
}

function redirectUriFor(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}`;
}
