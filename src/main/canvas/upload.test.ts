import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasUploadError, uploadSubmissionFile } from './upload';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

const FILE = {
  name: 'essay.pdf',
  size: 4,
  contentType: 'application/pdf',
  data: new Uint8Array([1, 2, 3, 4]),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

const SLOT = {
  upload_url: 'https://inst-fs.example.com/files',
  upload_params: { key: 'abc/def', signature: 'sig-value', policy: 'pol-value' },
};

/** Step 1 -> slot, step 2 -> 302 to confirm URL, step 3 -> the file object. */
function happyPathFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(SLOT))
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: new Headers({ location: 'https://uncw.instructure.com/api/v1/files/77?x=1' }) })
    )
    .mockResolvedValueOnce(jsonResponse({ id: 77, display_name: 'essay.pdf' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadSubmissionFile', () => {
  it('returns the confirmed Canvas file id', async () => {
    vi.stubGlobal('fetch', happyPathFetch());
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).resolves.toBe(77);
  });

  it('requests the slot from the assignment submissions files endpoint with name, size and type', async () => {
    const fetchMock = happyPathFetch();
    vi.stubGlobal('fetch', fetchMock);

    await uploadSubmissionFile(CREDS, 42, 10, FILE);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://uncw.instructure.com/api/v1/courses/42/assignments/10/submissions/self/files'
    );
    expect(JSON.parse(init.body)).toEqual({
      name: 'essay.pdf',
      size: 4,
      content_type: 'application/pdf',
    });
  });

  it('does NOT send an Authorization header on the signed upload', async () => {
    const fetchMock = happyPathFetch();
    vi.stubGlobal('fetch', fetchMock);

    await uploadSubmissionFile(CREDS, 42, 10, FILE);

    const uploadInit = fetchMock.mock.calls[1][1];
    const headers = new Headers(uploadInit.headers ?? {});
    expect(headers.has('authorization')).toBe(false);
    // And the token must not have leaked in under any other header either.
    for (const [, value] of headers.entries()) {
      expect(value).not.toContain('test-token');
    }
  });

  it('passes every upload_param through unmodified with the file field LAST', async () => {
    const fetchMock = happyPathFetch();
    vi.stubGlobal('fetch', fetchMock);

    await uploadSubmissionFile(CREDS, 42, 10, FILE);

    const body = fetchMock.mock.calls[1][1].body as FormData;
    const keys = Array.from(body.keys());
    expect(keys).toEqual(['key', 'signature', 'policy', 'file']);
    expect(body.get('key')).toBe('abc/def');
    expect(body.get('signature')).toBe('sig-value');
    expect(body.get('policy')).toBe('pol-value');
  });

  it('does not follow the upload redirect automatically', async () => {
    // Following it automatically would send the confirm request without auth.
    const fetchMock = happyPathFetch();
    vi.stubGlobal('fetch', fetchMock);

    await uploadSubmissionFile(CREDS, 42, 10, FILE);

    expect(fetchMock.mock.calls[1][1].redirect).toBe('manual');
  });

  it('DOES send auth on the confirm request', async () => {
    const fetchMock = happyPathFetch();
    vi.stubGlobal('fetch', fetchMock);

    await uploadSubmissionFile(CREDS, 42, 10, FILE);

    const confirmInit = fetchMock.mock.calls[2][1];
    const headers = new Headers(confirmInit.headers ?? {});
    expect(headers.get('authorization')).toBe('Bearer test-token');
    expect(fetchMock.mock.calls[2][0]).toBe('https://uncw.instructure.com/api/v1/files/77?x=1');
  });

  it('accepts a 201 with an inline file object instead of a redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(SLOT))
        .mockResolvedValueOnce(jsonResponse({ id: 88 }, 201))
    );
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).resolves.toBe(88);
  });

  it('reports a step-1 failure as step 1', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 400 })));
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toMatchObject({ step: 1 });
  });

  it('reports a step-2 failure as step 2, not as a rejected file', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(SLOT))
        .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
    );
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toMatchObject({ step: 2 });
  });

  it('reports a step-3 failure as step 3', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(SLOT))
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: new Headers({ location: 'https://uncw.instructure.com/api/v1/files/77' }) })
        )
        .mockResolvedValueOnce(new Response('nope', { status: 500 }))
    );
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toMatchObject({ step: 3 });
  });

  it('fails at step 2 when the redirect carries no location', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(SLOT))
        .mockResolvedValueOnce(new Response(null, { status: 302 }))
    );
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toMatchObject({ step: 2 });
  });

  it('fails at step 3 when the confirmed object has no id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(SLOT))
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: new Headers({ location: 'https://uncw.instructure.com/api/v1/files/77' }) })
        )
        .mockResolvedValueOnce(jsonResponse({ display_name: 'essay.pdf' }))
    );
    // Submitting with an unconfirmed id would attach nothing.
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toMatchObject({ step: 3 });
  });

  it('fails at step 1 when the slot response is missing upload_url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ upload_params: {} })));
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toMatchObject({ step: 1 });
  });

  it('is a CanvasUploadError so callers can narrow on it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 400 })));
    await expect(uploadSubmissionFile(CREDS, 42, 10, FILE)).rejects.toBeInstanceOf(CanvasUploadError);
  });
});
