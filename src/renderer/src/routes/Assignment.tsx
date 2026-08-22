import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAssignment } from '../assignment/useAssignment';
import { FileUploadPanel } from '../assignment/FileUploadPanel';
import { HandoffPanel } from '../assignment/HandoffPanel';
import { SubmitConfirm } from '../assignment/SubmitConfirm';
import { TextEntryPanel } from '../assignment/TextEntryPanel';
import type { PickedFile, SubmitInput } from '../assignment/types';
import { sanitizeHtml } from '../school/sanitizeHtml';
import { formatDue, formatRelative } from '../school/formatters';
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
  const when = submittedAt === null ? '' : ` ${formatRelative(submittedAt)}`;
  const graded = score === null ? '' : ` — scored ${score}${pointsPossible === null ? '' : ` / ${pointsPossible}`}`;
  return <span style={{ color: SCHOOL_ACCENT }}>{`Submitted${when}${graded}`}</span>;
}

export function Assignment(): React.JSX.Element {
  const { assignmentId } = useParams();
  const id = Number(assignmentId);
  const { detail, loaded, submitting, outcome, submit } = useAssignment(id);
  const [pending, setPending] = useState<{ input: SubmitInput; file?: PickedFile } | null>(null);

  // Assignment does not remount across route param changes (React Router
  // reuses the element), so a pending confirmation from a previously viewed
  // assignment must not survive the navigation to a new one.
  useEffect(() => {
    setPending(null);
  }, [id]);

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

        <div
          className="mt-6 flex min-h-0 flex-1 flex-col"
          data-testid="submission-region"
          // Forces a fresh mount of every panel below when the route's
          // assignmentId changes without unmounting Assignment itself
          // (React Router re-renders the same element across param changes).
          // Without this, TextEntryPanel's local text/dirty state and
          // FileUploadPanel's local file state would carry over from the
          // previous assignment. See Task 18's review note on TextEntryPanel.
          key={detail.id}
        >
          {detail.path.kind === 'handoff' && (
            <HandoffPanel htmlUrl={detail.htmlUrl} reason={detail.path.reason} />
          )}

          {detail.path.kind === 'none' && (
            <p style={{ color: 'var(--color-text-muted)' }}>
              This assignment does not take a submission.
            </p>
          )}

          {(detail.path.kind === 'text' ||
            detail.path.kind === 'text-or-file' ||
            detail.path.kind === 'discussion') && (
            <TextEntryPanel
              assignmentId={detail.id}
              initialDraft={detail.draft}
              isDiscussion={detail.path.kind === 'discussion'}
              disabled={submitting}
              onSubmit={(body) =>
                setPending({
                  input:
                    detail.path.kind === 'discussion'
                      ? { kind: 'discussion', message: body }
                      : { kind: 'text', body },
                })
              }
            />
          )}

          {(detail.path.kind === 'file' || detail.path.kind === 'text-or-file') && (
            <div className={detail.path.kind === 'text-or-file' ? 'mt-6' : ''}>
              <FileUploadPanel
                disabled={submitting}
                onSubmit={(file) => setPending({ input: { kind: 'file', filePath: file.path }, file })}
              />
            </div>
          )}

          {outcome !== null && (
            <p
              className="mt-4 text-sm"
              // A failure and an unconfirmed submission both need announcing;
              // a confirmed success does not interrupt.
              role={outcome.ok && outcome.verified ? undefined : 'alert'}
              style={{ color: outcome.ok ? 'var(--color-text)' : '#EF4444' }}
            >
              {outcome.message}
            </p>
          )}
        </div>
      </div>

      {pending !== null && (
        <SubmitConfirm
          assignmentName={detail.name}
          input={pending.input}
          isDiscussion={pending.input.kind === 'discussion'}
          fileName={pending.file?.name}
          fileSize={pending.file?.size}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const input = pending.input;
            setPending(null);
            void submit(input);
          }}
        />
      )}
    </div>
  );
}
