import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
    renderAt(42);
    await waitFor(() => expect(getAssignment).toHaveBeenCalledWith(42));
  });
});
