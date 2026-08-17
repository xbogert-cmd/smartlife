import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider';

const OPTIONS = ['light', 'dark', 'system'] as const;

export function Settings() {
  const { preference, setPreference } = useTheme();
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.smartlife.app.getVersion().then(setVersion);
  }, []);

  return (
    <div className="flex flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
        Settings
      </h1>
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Theme</span>
        <div className="flex gap-2">
          {OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreference(option)}
              className="rounded-md px-3 py-1.5 text-sm capitalize"
              style={{
                backgroundColor: preference === option ? 'var(--color-text)' : 'var(--color-surface)',
                color: preference === option ? 'var(--color-bg)' : 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: 'var(--color-text-muted)' }}>SmartLife v{version}</p>
    </div>
  );
}
