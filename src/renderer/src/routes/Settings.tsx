import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider';

const OPTIONS = ['light', 'dark', 'system'] as const;

export function Settings() {
  const { preference, setPreference } = useTheme();
  const [version, setVersion] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyError, setApiKeyError] = useState('');

  useEffect(() => {
    window.smartlife.app.getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    window.smartlife.ai.getApiKeyStatus().then(setApiKeyConfigured);
  }, []);

  async function handleSaveApiKey(): Promise<void> {
    setApiKeyError('');
    try {
      await window.smartlife.ai.setApiKey(apiKeyInput);
      setApiKeyInput('');
      setApiKeyConfigured(true);
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save key.');
    }
  }

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
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Claude API key {apiKeyConfigured === true ? '— connected' : apiKeyConfigured === false ? '— not connected' : ''}
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-ant-..."
            className="rounded-md px-3 py-1.5 text-sm"
            style={{
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          />
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={apiKeyInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{
              backgroundColor: 'var(--color-text)',
              color: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
            }}
          >
            Save
          </button>
        </div>
        {apiKeyError && <span style={{ color: '#F87171' }}>{apiKeyError}</span>}
      </div>
      <p style={{ color: 'var(--color-text-muted)' }}>SmartLife v{version}</p>
    </div>
  );
}
