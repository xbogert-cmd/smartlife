import { Link, useParams } from 'react-router-dom';
import { useAssignment } from '../assignment/useAssignment';
import { sanitizeHtml } from '../school/sanitizeHtml';
import { formatDue } from '../school/formatters';
import { SCHOOL_ACCENT } from '../school/types';

function StatusLine({
  hasSubmitted,
  submittedAt,
  score,
  pointsPossible,
}: {
  hasSubmitted: boolean;
  submittedAt: string | null;
  score: number | null;
  pointsPossible: number | null;
}): React.JSX.Element {
  if (!hasSubmitted) {
    return (
      <span style={{ color: 'var(--color-text-muted)' }}>Not submitted</span>
    );
  }
  const when = submittedAt === null ? '' : ` ${formatDue(submittedAt)}`;
  const graded = score === null ? '' : ` — scored ${score}${pointsPossible === null ? '' : ` / ${pointsPossible}`}`;
  return <span style={{ color: SCHOOL_ACCENT }}>{`Submitted${when}${graded}`}</span>;
}

export function Assignment(): React.JSX.Element {
  const { assignmentId } = useParams();
  const id = Number(assignmentId);
  const { detail, loaded } = useAssignment(id);

  if (!loaded) {
    return <div className="p-8" style={{ color: 'var(--color-text-muted)' }}>Loading…</div>;
  }

  if (detail === null) {
    return (
      <div className="p-8" role="alert">
        <p style={{ color: 'var(--color-text)' }}>
          We couldn&apos;t find that assignment locally. Try syncing its course.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="border-b px-6 py-4" style={{ borderColor: 'var(--color-border)' }}>
        <Link
          to={`/school/course/${detail.courseId}`}
          className="text-sm hover:underline"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {detail.courseName}
        </Link>
        <h1 className="mt-1 text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          {detail.name}
        </h1>
        <p className="mt-1 text-sm">
          {detail.dueAt !== null && (
            <span style={{ color: 'var(--color-text-muted)' }}>Due {formatDue(detail.dueAt)} · </span>
          )}
          {detail.pointsPossible !== null && (
            <span style={{ color: 'var(--color-text-muted)' }}>{detail.pointsPossible} points · </span>
          )}
          <StatusLine
            hasSubmitted={detail.hasSubmitted}
            submittedAt={detail.submittedAt}
            score={detail.score}
            pointsPossible={detail.pointsPossible}
          />
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {detail.description !== null && (
          <div
            className="prose-sm max-w-none"
            style={{ color: 'var(--color-text)' }}
            // sanitizeHtml is Phase 3's existing allowlist sanitizer; Canvas
            // descriptions are instructor-authored HTML and are never trusted raw.
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.description) }}
          />
        )}

        {/* Tasks 18-20 replace this block with the real per-path panels. */}
        <div className="mt-6" data-testid="submission-region">
          {detail.path.kind === 'handoff' && <p>This assignment is completed in the browser.</p>}
          {detail.path.kind === 'none' && <p>This assignment does not take a submission.</p>}
          {(detail.path.kind === 'text' || detail.path.kind === 'discussion') && <p>Text submission.</p>}
          {detail.path.kind === 'file' && <p>File submission.</p>}
          {detail.path.kind === 'text-or-file' && <p>Text or file submission.</p>}
        </div>
      </div>
    </div>
  );
}
