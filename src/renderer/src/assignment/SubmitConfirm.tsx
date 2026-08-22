import type { SubmitInput } from './types';

interface SubmitConfirmProps {
  assignmentName: string;
  input: SubmitInput;
  isDiscussion: boolean;
  fileName?: string;
  fileSize?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shows exactly what is about to leave the machine. Never summarise or
 * truncate the body: the user is approving specific bytes, and a shortened
 * preview is not the thing they would be agreeing to.
 */
export function SubmitConfirm({
  assignmentName,
  input,
  isDiscussion,
  fileName,
  fileSize,
  onConfirm,
  onCancel,
}: SubmitConfirmProps): React.JSX.Element {
  const text = input.kind === 'text' ? input.body : input.kind === 'discussion' ? input.message : null;

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div
        role="dialog"
        aria-label="Confirm submission"
        aria-modal="true"
        className="flex max-h-[80vh] w-[560px] flex-col rounded-xl"
        style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
      >
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--color-border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
            Submit to "{assignmentName}"?
          </h2>
          {isDiscussion && (
            <p className="mt-2 text-sm" style={{ color: 'var(--color-text)' }}>
              This is a discussion post. It will be visible to your whole class, and students usually
              cannot delete their own posts.
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <p className="mb-2 text-xs uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            Exactly what will be submitted
          </p>
          {text !== null ? (
            <pre
              className="whitespace-pre-wrap break-words rounded-md p-3 text-sm"
              style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              {text}
            </pre>
          ) : (
            <p className="text-sm" style={{ color: 'var(--color-text)' }}>
              {fileName ?? 'A file'}
              {typeof fileSize === 'number' && ` — ${fileSize.toLocaleString('en-US')} bytes`}
            </p>
          )}
        </div>

        <div
          className="flex justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ backgroundColor: '#3B82F6' }}
          >
            Submit to Canvas
          </button>
        </div>
      </div>
    </div>
  );
}
