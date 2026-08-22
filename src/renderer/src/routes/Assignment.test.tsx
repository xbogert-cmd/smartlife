import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { Assignment } from './Assignment';

const getAssignment = vi.fn();

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    courseId: 1,
    courseName: 'Financial Accounting',
    name: 'Chapter 4 Homework',
    description: '<p>Read chapter four.</p>',
    dueAt: '2026-08-25T04:00:00Z',
    pointsPossible: 20,
    htmlUrl: 'https://uncw.instructure.com/courses/1/assignments/10',
    hasSubmitted: false,
    submittedAt: null,
    score: null,
    grade: null,
    workflowState: null,
    path: { kind: 'file' },
    draft: null,
    ...overrides,
  };
}

beforeEach(() => {
  getAssignment.mockReset().mockResolvedValue(detail());
  (window as unknown as { smartlife: unknown }).smartlife = {
    canvas: {
      getAssignment,
      saveDraft: vi.fn().mockResolvedValue(undefined),
      clearDraft: vi.fn().mockResolvedValue(undefined),
      pickFile: vi.fn().mockResolvedValue(null),
      submit: vi.fn().mockResolvedValue({ ok: true, verified: true, submittedAt: null, message: 'ok' }),
    },
    browser: {
      openTab: vi.fn().mockResolvedValue('t1'),
      setBounds: vi.fn().mockResolvedValue(undefined),
      setRouteActive: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function renderAt(id = 10) {
  return render(
    <MemoryRouter initialEntries={[`/assignment/${id}`]}>
      <Routes>
        <Route path="/assignment/:assignmentId" element={<Assignment />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Assignment route', () => {
  it('shows the assignment name and course', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { name: 'Chapter 4 Homework' })).toBeTruthy();
    expect(screen.getByText(/Financial Accounting/)).toBeTruthy();
  });

  it('renders the sanitized description', async () => {
    renderAt();
    expect(await screen.findByText('Read chapter four.')).toBeTruthy();
  });

  it('strips scripts out of the description', async () => {
    getAssignment.mockResolvedValue(
      detail({ description: '<p>safe</p><script>window.pwned = 1</script>' })
    );
    const { container } = renderAt();
    await screen.findByText('safe');
    expect(container.querySelector('script')).toBeNull();
  });

  it('shows a not-submitted state', async () => {
    renderAt();
    expect(await screen.findByText(/not submitted/i)).toBeTruthy();
  });

  it('shows the submitted timestamp when submitted', async () => {
    getAssignment.mockResolvedValue(
      detail({ hasSubmitted: true, submittedAt: '2026-08-20T10:00:00Z' })
    );
    renderAt();
    expect(await screen.findByText(/submitted/i)).toBeTruthy();
  });

  it('reports a missing assignment instead of rendering an empty shell', async () => {
    getAssignment.mockResolvedValue(null);
    renderAt(999);
    await waitFor(() => expect(screen.getByText(/couldn't find/i)).toBeTruthy());
  });

  it('requests the assignment id from the route', async () => {
    getAssignment.mockImplementation((requestedId: number) =>
      Promise.resolve(requestedId === 42 ? detail({ name: 'Right One' }) : detail({ name: 'Wrong One' }))
    );
    renderAt(42);
    expect(await screen.findByRole('heading', { name: 'Right One' })).toBeTruthy();
  });
});

describe('Assignment route — submission wiring', () => {
  it('confirms before submitting text', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'text' }, draft: 'my answer' }));
    const submit = (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit;
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /^submit$/i }));

    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /confirm submission/i })).toBeTruthy();
  });

  it('submits only after the dialog is confirmed', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'text' }, draft: 'my answer' }));
    const submit = (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit;
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /^submit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit to canvas/i }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith(10, { kind: 'text', body: 'my answer' }));
  });

  it('does not submit when the dialog is cancelled', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'text' }, draft: 'x' }));
    const submit = (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit;
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /^submit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(submit).not.toHaveBeenCalled();
  });

  it('sends a discussion post as a discussion submission', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'discussion', topicId: 55 }, draft: 'my post' }));
    const submit = (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit;
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /post to discussion/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit to canvas/i }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(10, { kind: 'discussion', message: 'my post' })
    );
  });

  it('surfaces an unverified outcome instead of claiming success', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'text' }, draft: 'x' }));
    (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit.mockResolvedValue({
        ok: true,
        verified: false,
        submittedAt: null,
        message: "Submitted, but we couldn't confirm it — check Canvas.",
      });
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /^submit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit to canvas/i }));

    expect(await screen.findByText(/couldn't confirm/i)).toBeTruthy();
  });

  it('surfaces a failure message', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'text' }, draft: 'x' }));
    (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit.mockResolvedValue({
        ok: false,
        verified: false,
        submittedAt: null,
        message: 'Canvas refused the submission.',
      });
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /^submit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit to canvas/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows both surfaces for a text-or-file assignment', async () => {
    getAssignment.mockResolvedValue(detail({ path: { kind: 'text-or-file' } }));
    renderAt();
    expect(await screen.findByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: /choose file/i })).toBeTruthy();
  });

  it('clears a stale outcome banner when navigating to a different assignment', async () => {
    // React Router reuses the Assignment element across a param-only
    // navigation (no remount), so this renders both assignments under the
    // same Route and navigates via a real Link click, matching production.
    getAssignment.mockImplementation((requestedId: number) =>
      Promise.resolve(
        requestedId === 10
          ? detail({ id: 10, path: { kind: 'text' }, draft: 'x' })
          : detail({ id: 11, name: 'Assignment Eleven', path: { kind: 'file' } })
      )
    );
    (window as unknown as { smartlife: { canvas: { submit: ReturnType<typeof vi.fn> } } })
      .smartlife.canvas.submit.mockResolvedValue({
        ok: false,
        verified: false,
        submittedAt: null,
        message: 'Canvas refused the submission.',
      });

    render(
      <MemoryRouter initialEntries={['/assignment/10']}>
        <Routes>
          <Route
            path="/assignment/:assignmentId"
            element={
              <>
                <Assignment />
                <Link to="/assignment/11">Go to eleven</Link>
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByRole('button', { name: /^submit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit to canvas/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Canvas refused/)).toBeTruthy();

    await userEvent.click(screen.getByRole('link', { name: /go to eleven/i }));

    await screen.findByRole('heading', { name: 'Assignment Eleven' });
    expect(screen.queryByText(/Canvas refused/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
