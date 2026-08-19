import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Course } from './Course';

const canvas = {
  getCourse: vi.fn(),
  syncCourse: vi.fn(),
  getPage: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  getStatus: vi.fn(),
  onSyncChanged: vi.fn().mockReturnValue(() => {}),
};

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    course: { id: 101, name: 'Statistics', courseCode: 'STT 215', currentScore: 91.5, currentGrade: 'A-' },
    assignments: [],
    modules: [],
    files: [],
    announcements: [],
    contentSyncedAt: '2026-08-18T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', { value: { canvas }, writable: true, configurable: true });
  canvas.getCourse.mockReset().mockResolvedValue(detail());
  canvas.syncCourse.mockReset().mockResolvedValue({ ok: true, tokenInvalid: false, errors: [] });
  canvas.getPage.mockReset();
  canvas.openFile.mockReset().mockResolvedValue({ ok: true });
  canvas.openExternal.mockReset().mockResolvedValue({ ok: true });
  canvas.getStatus.mockResolvedValue({
    tokenConfigured: true,
    baseUrlConfigured: true,
    lastSyncedAt: null,
    tokenInvalid: false,
    tokenAgeDays: 1,
    tokenExpiringSoon: false,
  });
});

function renderCourse(): void {
  render(
    <MemoryRouter initialEntries={['/school/course/101']}>
      <Routes>
        <Route path="/school/course/:courseId" element={<Course />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Course', () => {
  it('renders the course name and current grade', async () => {
    renderCourse();
    expect(await screen.findByText('Statistics')).toBeInTheDocument();
    expect(screen.getByText(/91.5%/)).toBeInTheDocument();
  });

  it('triggers a content sync the first time a course has never been synced', async () => {
    canvas.getCourse.mockResolvedValue(detail({ contentSyncedAt: null }));
    renderCourse();
    await waitFor(() => expect(canvas.syncCourse).toHaveBeenCalledWith(101));
  });

  it('does not re-sync a course whose content is already cached', async () => {
    renderCourse();
    await screen.findByText('Statistics');
    expect(canvas.syncCourse).not.toHaveBeenCalled();
  });

  it('lists modules with their items', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [{ id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null }],
          },
        ],
      })
    );
    renderCourse();

    expect(await screen.findByText('Week 1')).toBeInTheDocument();
    expect(screen.getByText('Syllabus')).toBeInTheDocument();
  });

  it('opens a file through the main process when a file item is clicked', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({ files: [{ id: 7, displayName: 'Lecture 1.pdf', contentType: 'application/pdf', size: 2048 }] })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Lecture 1.pdf'));

    expect(canvas.openFile).toHaveBeenCalledWith(7);
  });

  it('surfaces an error when opening a file fails', async () => {
    canvas.openFile.mockResolvedValue({ ok: false, error: 'Download failed with status 404.' });
    canvas.getCourse.mockResolvedValue(
      detail({ files: [{ id: 7, displayName: 'Lecture 1.pdf', contentType: 'application/pdf', size: 2048 }] })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Lecture 1.pdf'));

    expect(await screen.findByText(/download failed with status 404/i)).toBeInTheDocument();
  });

  it('fetches and renders a page body when a page item is clicked', async () => {
    canvas.getPage.mockResolvedValue({ title: 'Syllabus', body: '<p>Read chapter 1</p>' });
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [{ id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null }],
          },
        ],
      })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Syllabus'));

    await waitFor(() => expect(canvas.getPage).toHaveBeenCalledWith(101, 'syllabus'));
    expect(await screen.findByText('Read chapter 1')).toBeInTheDocument();
  });

  it('strips scripts out of page HTML before rendering', async () => {
    canvas.getPage.mockResolvedValue({ title: 'Syllabus', body: '<p>ok</p><script>alert(1)</script>' });
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [{ id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null }],
          },
        ],
      })
    );
    const { container } = render(
      <MemoryRouter initialEntries={['/school/course/101']}>
        <Routes>
          <Route path="/school/course/:courseId" element={<Course />} />
        </Routes>
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByText('Syllabus'));

    await screen.findByText('ok');
    expect(container.querySelector('script')).toBeNull();
  });

  it('opens an external-link item through the main process', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [
              {
                id: 1001,
                title: 'Course website',
                type: 'ExternalUrl',
                contentId: null,
                pageUrl: null,
                externalUrl: 'https://example.edu/stats',
              },
            ],
          },
        ],
      })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Course website'));

    expect(canvas.openExternal).toHaveBeenCalledWith('https://example.edu/stats');
  });

  it('lists assignments with their scores', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({
        assignments: [
          {
            id: 555,
            name: 'Problem Set 3',
            dueAt: '2026-09-01T03:59:59Z',
            pointsPossible: 20,
            hasSubmitted: true,
            score: 18,
            grade: '18',
            htmlUrl: null,
          },
        ],
      })
    );
    renderCourse();

    expect(await screen.findByText('Problem Set 3')).toBeInTheDocument();
    expect(screen.getByText('18 / 20')).toBeInTheDocument();
  });

  it('reports a course that is not in the local mirror', async () => {
    canvas.getCourse.mockResolvedValue(null);
    renderCourse();
    expect(await screen.findByText(/course was not found/i)).toBeInTheDocument();
  });
});
