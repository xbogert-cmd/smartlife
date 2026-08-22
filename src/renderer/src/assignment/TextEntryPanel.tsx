import { useEffect, useRef, useState } from 'react';

const AUTOSAVE_MS = 800;

interface TextEntryPanelProps {
  assignmentId: number;
  initialDraft: string | null;
  isDiscussion: boolean;
  disabled?: boolean;
  onSubmit: (body: string) => void;
}

export function TextEntryPanel({
  assignmentId,
  initialDraft,
  isDiscussion,
  disabled = false,
  onSubmit,
}: TextEntryPanelProps): React.JSX.Element {
  const [text, setText] = useState(initialDraft ?? '');
  // Nothing has changed yet on mount, so writing the draft we just loaded back
  // to disk would be a pointless write on every route visit.
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      void window.smartlife.canvas.saveDraft(assignmentId, text).catch(() => {});
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [assignmentId, text]);

  const label = isDiscussion ? 'Post to discussion' : 'Submit';

  return (
    <section aria-label={isDiscussion ? 'Discussion post' : 'Text submission'}>
      <textarea
        value={text}
        onChange={(event) => {
          dirty.current = true;
          setText(event.target.value);
        }}
        rows={12}
        aria-label={isDiscussion ? 'Your post' : 'Your submission'}
        className="w-full rounded-md p-3 text-sm"
        style={{
          backgroundColor: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text)',
        }}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (text.trim().length === 0) return;
            onSubmit(text);
          }}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: '#3B82F6' }}
        >
          {label}
        </button>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Saved locally as you type.
        </span>
      </div>
    </section>
  );
}
