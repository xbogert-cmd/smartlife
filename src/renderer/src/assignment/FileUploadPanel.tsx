import { useState } from 'react';
import type { PickedFile } from './types';

interface FileUploadPanelProps {
  disabled?: boolean;
  onSubmit: (file: PickedFile) => void;
}

export function FileUploadPanel({ disabled = false, onSubmit }: FileUploadPanelProps): React.JSX.Element {
  const [file, setFile] = useState<PickedFile | null>(null);

  async function choose(): Promise<void> {
    // Native dialog, driven main-side. The renderer only ever holds a path and
    // display metadata; file bytes are read in the main process at submit time.
    const picked = (await window.smartlife.canvas.pickFile()) as PickedFile | null;
    // A cancelled picker returns null, which must not clear an earlier choice.
    if (picked !== null) setFile(picked);
  }

  return (
    <section aria-label="File submission">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void choose()}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          {file === null ? 'Choose file' : 'Choose a different file'}
        </button>
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {file === null ? 'No file chosen' : `${file.name} — ${file.size.toLocaleString('en-US')} bytes`}
        </span>
      </div>
      <button
        type="button"
        disabled={disabled || file === null}
        onClick={() => {
          if (file !== null) onSubmit(file);
        }}
        className="mt-3 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        style={{ backgroundColor: '#3B82F6' }}
      >
        Submit
      </button>
    </section>
  );
}
