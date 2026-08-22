import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMySubmission,
  listDiscussionTopics,
  postDiscussionEntry,
  postSubmission,
} from './api';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listDiscussionTopics', () => {
  it('requests the course discussion topics endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 5, assignment_id: 10 }]));
    vi.stubGlobal('fetch', fetchMock);

    const topics = await listDiscussionTopics(CREDS, 42);

    expect(topics).toEqual([{ id: 5, assignment_id: 10 }]);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/courses/42/discussion_topics');
  });
});

describe('getMySubmission', () => {
  it('reads the self submission for an assignment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: 900, submitted_at: '2026-08-22T10:00:00Z', workflow_state: 'submitted' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const submission = await getMySubmission(CREDS, 42, 10);

    expect(submission.workflow_state).toBe('submitted');
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/api/v1/courses/42/assignments/10/submissions/self'
    );
  });
});

describe('postSubmission', () => {
  it('nests the payload under `submission` as Canvas expects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 900 }));
    vi.stubGlobal('fetch', fetchMock);

    await postSubmission(CREDS, 42, 10, { submission_type: 'online_text_entry', body: '<p>hi</p>' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://uncw.instructure.com/api/v1/courses/42/assignments/10/submissions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      submission: { submission_type: 'online_text_entry', body: '<p>hi</p>' },
    });
  });

  it('sends file_ids for an upload submission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 901 }));
    vi.stubGlobal('fetch', fetchMock);

    await postSubmission(CREDS, 42, 10, { submission_type: 'online_upload', file_ids: [7, 8] });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      submission: { submission_type: 'online_upload', file_ids: [7, 8] },
    });
  });

  it('omits fields that were not supplied rather than sending nulls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 902 }));
    vi.stubGlobal('fetch', fetchMock);

    await postSubmission(CREDS, 42, 10, { submission_type: 'online_upload', file_ids: [7] });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).submission;
    expect('body' in sent).toBe(false);
    expect('url' in sent).toBe(false);
  });
});

describe('postDiscussionEntry', () => {
  it('posts the message to the topic entries endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 33 }));
    vi.stubGlobal('fetch', fetchMock);

    await postDiscussionEntry(CREDS, 42, 5, 'my post');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://uncw.instructure.com/api/v1/courses/42/discussion_topics/5/entries');
    expect(JSON.parse(init.body)).toEqual({ message: 'my post' });
  });
});
