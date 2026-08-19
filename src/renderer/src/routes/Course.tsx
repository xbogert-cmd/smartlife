import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { sanitizeHtml } from '../school/sanitizeHtml';
import { formatDue } from '../school/formatters';
import { SCHOOL_ACCENT, type CourseDetail, type ModuleItemRow } from '../school/types';

interface OpenPage {
  title: string | null;
  body: string | null;
}

export function Course(): React.JSX.Element {
  const { courseId } = useParams();
  const id = Number(courseId);
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState<OpenPage | null>(null);

  const load = useCallback(async (): Promise<CourseDetail | null> => {
    const next = (await window.smartlife.canvas.getCourse(id)) as CourseDetail | null;
    setDetail(next);
    setLoaded(true);
    return next;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const first = await load();
      // Tier-2 content is pulled the first time a course is opened, then cached.
      if (!cancelled && first !== null && first.contentSyncedAt === null) {
        await window.smartlife.canvas.syncCourse(id);
        if (!cancelled) await load();
      }
    })().catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [id, load]);

  async function openItem(item: ModuleItemRow): Promise<void> {
    setError('');
    if (item.type === 'Page' && item.pageUrl) {
      const result = (await window.smartlife.canvas.getPage(id, item.pageUrl)) as OpenPage | null;
      setPage(result ?? { title: item.title, body: null });
      return;
    }
    if (item.type === 'File' && item.contentId !== null) {
      const result = await window.smartlife.canvas.openFile(item.contentId);
      if (!result.ok) setError(result.error ?? 'Could not open that file.');
      return;
    }
    if (item.externalUrl) {
      const result = await window.smartlife.canvas.openExternal(item.externalUrl);
      if (!result.ok) setError(result.error ?? 'Could not open that link.');
    }
  }

  async function openFile(fileId: number): Promise<void> {
    setError('');
    const result = await window.smartlife.canvas.openFile(fileId);
    if (!result.ok) setError(result.error ?? 'Could not open that file.');
  }

  if (loaded && detail === null) {
    return (
      <div className="flex flex-col gap-3 p-8">
        <p style={{ color: 'var(--color-text)' }}>That course was not found in your synced data.</p>
        <Link to="/school" style={{ color: SCHOOL_ACCENT }}>
          Back to School
        </Link>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="p-8">
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      </div>
    );
  }

  const rowStyle = {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
  } as const;

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <Link to="/school" className="text-sm" style={{ color: SCHOOL_ACCENT }}>
          ← School
        </Link>
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
            {detail.course.name}
          </h1>
          <span style={{ color: 'var(--color-text)' }}>
            {detail.course.currentScore === null
              ? '—'
              : `${detail.course.currentScore}%${detail.course.currentGrade ? ` (${detail.course.currentGrade})` : ''}`}
          </span>
        </div>
        {detail.course.courseCode && (
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {detail.course.courseCode}
          </span>
        )}
      </div>

      {error && <p style={{ color: '#F87171' }}>{error}</p>}

      {page !== null && (
        <section className="flex flex-col gap-2 rounded-lg p-4" style={rowStyle}>
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
              {page.title ?? 'Page'}
            </h2>
            <button
              type="button"
              onClick={() => setPage(null)}
              className="text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Close
            </button>
          </div>
          {page.body === null ? (
            <p style={{ color: 'var(--color-text-muted)' }}>This page has no content.</p>
          ) : (
            <div
              className="text-sm"
              style={{ color: 'var(--color-text)' }}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(page.body) }}
            />
          )}
        </section>
      )}

      <Section title="Assignments">
        {detail.assignments.length === 0 ? (
          <Empty>No assignments synced.</Empty>
        ) : (
          detail.assignments.map((assignment) => (
            <div key={assignment.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={rowStyle}>
              <div className="flex flex-col">
                <span style={{ color: 'var(--color-text)' }}>{assignment.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {assignment.dueAt ? formatDue(assignment.dueAt) : 'no due date'}
                </span>
              </div>
              <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                {assignment.score === null
                  ? assignment.hasSubmitted
                    ? 'submitted'
                    : '—'
                  : `${assignment.score} / ${assignment.pointsPossible ?? '?'}`}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section title="Modules">
        {detail.modules.length === 0 ? (
          <Empty>No modules synced.</Empty>
        ) : (
          detail.modules.map((module) => (
            <div key={module.id} className="flex flex-col gap-1.5 rounded-lg p-3" style={rowStyle}>
              <span className="font-medium" style={{ color: 'var(--color-text)' }}>
                {module.name ?? 'Untitled module'}
              </span>
              {module.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openItem(item)}
                  className="text-left text-sm"
                  style={{ color: SCHOOL_ACCENT }}
                >
                  {item.title ?? 'Untitled'}
                </button>
              ))}
            </div>
          ))
        )}
      </Section>

      <Section title="Files">
        {detail.files.length === 0 ? (
          <Empty>No files synced.</Empty>
        ) : (
          detail.files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => void openFile(file.id)}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-left"
              style={rowStyle}
            >
              <span style={{ color: SCHOOL_ACCENT }}>{file.displayName ?? 'Untitled file'}</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {file.contentType ?? ''}
              </span>
            </button>
          ))
        )}
      </Section>

      <Section title="Announcements">
        {detail.announcements.length === 0 ? (
          <Empty>No announcements.</Empty>
        ) : (
          detail.announcements.map((announcement) => (
            <div key={announcement.id} className="rounded-lg px-3 py-2" style={rowStyle}>
              <span style={{ color: 'var(--color-text)' }}>{announcement.title ?? 'Untitled'}</span>
              {announcement.message && (
                <div
                  className="mt-1 text-sm"
                  style={{ color: 'var(--color-text-muted)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(announcement.message) }}
                />
              )}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p style={{ color: 'var(--color-text-muted)' }}>{children}</p>;
}
