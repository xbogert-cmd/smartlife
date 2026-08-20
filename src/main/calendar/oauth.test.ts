import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const CONFIG = { clientId: 'client-123', clientSecret: 'secret-abc' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generatePkcePair', () => {
  it('produces a URL-safe verifier of legal length and a different challenge', async () => {
    const { generatePkcePair } = await import('./oauth');
    const { verifier, challenge } = generatePkcePair();

    // RFC 7636 requires 43-128 characters from the unreserved set.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    // The challenge is the S256 hash, so it must never equal the verifier --
    // sending the verifier as the challenge silently disables PKCE.
    expect(challenge).not.toBe(verifier);
  });

  it('produces a different verifier every call', async () => {
    const { generatePkcePair } = await import('./oauth');
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });
});

describe('buildAuthUrl', () => {
  it('requests offline access with consent and sends the S256 challenge', async () => {
    const { buildAuthUrl, GOOGLE_CALENDAR_SCOPE } = await import('./oauth');
    const url = new URL(buildAuthUrl('client-123', 'http://127.0.0.1:5555', 'chal', 'st4te'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st4te');
    // Without access_type=offline Google returns no refresh token at all, and
    // without prompt=consent it omits it on every re-authorization after the
    // first -- both produce an app that silently stops syncing in a week.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE);
  });
});

describe('exchangeCodeForTokens', () => {
  it('posts the PKCE verifier and returns the parsed tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { exchangeCodeForTokens } = await import('./oauth');
    const result = await exchangeCodeForTokens(CONFIG, 'the-code', 'http://127.0.0.1:5555', 'the-verifier');

    expect(result).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3599 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_secret')).toBe('secret-abc');
  });

  it('maps a rejected grant to GoogleAuthError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      )
    );

    const { exchangeCodeForTokens } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');
    await expect(
      exchangeCodeForTokens(CONFIG, 'bad', 'http://127.0.0.1:5555', 'v')
    ).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe('refreshAccessToken', () => {
  it('sends grant_type=refresh_token and tolerates a response with no new refresh token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3599 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { refreshAccessToken } = await import('./oauth');
    const result = await refreshAccessToken(CONFIG, 'rt-1');

    // Google omits refresh_token on refresh responses; treating that as an
    // error would break every sync after the first hour.
    expect(result).toEqual({ accessToken: 'at-2', refreshToken: null, expiresIn: 3599 });
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-1');
  });

  it('maps a revoked grant to GoogleAuthError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      )
    );
    const { refreshAccessToken } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');
    await expect(refreshAccessToken(CONFIG, 'dead')).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('maps a network failure to GoogleNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { refreshAccessToken } = await import('./oauth');
    const { GoogleNetworkError } = await import('./errors');
    await expect(refreshAccessToken(CONFIG, 'rt')).rejects.toBeInstanceOf(GoogleNetworkError);
  });
});

describe('runOAuthFlow', () => {
  // The loopback callback in these tests is a REAL HTTP request to the real
  // server the flow just started. Stubbing global fetch outright would
  // swallow that call too, and the flow would hang until its timeout -- so the
  // stub passes 127.0.0.1 through and only fakes Google's token endpoint.
  const realFetch = globalThis.fetch.bind(globalThis);

  function stubTokenEndpoint(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(url, init);
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
  }

  /** Mimics the user approving (or declining) in their browser. */
  function callBack(authUrl: string, params: Record<string, string>): void {
    const parsed = new URL(authUrl);
    const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
    const query = new URLSearchParams(params).toString();
    void fetch(`${redirectUri}/?${query}`).catch(() => {});
  }

  it('completes when the browser redirect carries a matching state', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');

    const pending = runOAuthFlow(CONFIG, (url) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callBack(url, { code: 'the-code', state });
    });

    await expect(pending).resolves.toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresIn: 3599,
    });
  });

  it('rejects a callback whose state does not match', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');

    const pending = runOAuthFlow(CONFIG, (url) => {
      // Any other local process could reach this port. Without the state
      // check it could inject its own authorization code.
      callBack(url, { code: 'attacker-code', state: 'wrong-state' });
    });

    await expect(pending).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('never exchanges a code when the state is wrong', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');

    await runOAuthFlow(CONFIG, (url) => {
      callBack(url, { code: 'attacker-code', state: 'wrong-state' });
    }).catch(() => {});

    const exchanges = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([input]) => String(input).includes('oauth2.googleapis.com'));
    // Rejecting after exchanging would still have burned the code.
    expect(exchanges).toHaveLength(0);
  });

  it('rejects when Google returns an error instead of a code', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');

    const pending = runOAuthFlow(CONFIG, (url) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callBack(url, { error: 'access_denied', state });
    });

    await expect(pending).rejects.toBeInstanceOf(GoogleAuthError);
  });
});
