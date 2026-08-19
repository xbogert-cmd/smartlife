import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider';

const OPTIONS = ['light', 'dark', 'system'] as const;

export function Settings() {
  const { preference, setPreference } = useTheme();
  const [version, setVersion] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyError, setApiKeyError] = useState('');
  const [aiMode, setAiModeState] = useState<'ask' | 'assist' | 'auto' | null>(null);
  const [canvasUrlInput, setCanvasUrlInput] = useState('');
  const [canvasTokenInput, setCanvasTokenInput] = useState('');
  const [canvasStatus, setCanvasStatus] = useState<{ tokenConfigured: boolean; baseUrlConfigured: boolean } | null>(null);
  const [canvasMessage, setCanvasMessage] = useState('');
  const [canvasError, setCanvasError] = useState('');

  useEffect(() => {
    window.smartlife.app.getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    window.smartlife.ai.getApiKeyStatus().then(setApiKeyConfigured);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getMode().then(setAiModeState);
  }, []);

  useEffect(() => {
    window.smartlife.canvas
      .getStatus()
      .then((status) => setCanvasStatus(status))
      .catch(() => {});
  }, []);

  async function handleSetAiMode(mode: 'ask' | 'assist' | 'auto'): Promise<void> {
    setAiModeState(mode);
    await window.smartlife.ai.setMode(mode);
  }

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

  async function handleSaveCanvas(): Promise<void> {
    setCanvasError('');
    setCanvasMessage('');
    try {
      if (canvasUrlInput.trim().length > 0) await window.smartlife.canvas.setBaseUrl(canvasUrlInput);
      if (canvasTokenInput.length > 0) await window.smartlife.canvas.setToken(canvasTokenInput);
      setCanvasUrlInput('');
      setCanvasTokenInput('');
      setCanvasStatus(await window.smartlife.canvas.getStatus());
      setCanvasMessage('Saved.');
    } catch (err) {
      setCanvasError(err instanceof Error ? err.message : 'Failed to save Canvas settings.');
    }
  }

  async function handleTestCanvas(): Promise<void> {
    setCanvasError('');
    setCanvasMessage('Testing…');
    const result = await window.smartlife.canvas.testConnection();
    if (result.ok) {
      setCanvasMessage(`Connected as ${result.name}.`);
    } else {
      setCanvasMessage('');
      setCanvasError(result.error ?? 'Could not reach Canvas.');
    }
  }

  async function handleDisconnectCanvas(): Promise<void> {
    await window.smartlife.canvas.clearToken();
    setCanvasStatus(await window.smartlife.canvas.getStatus());
    setCanvasMessage('Token removed.');
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
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>AI permission mode</span>
        <div className="flex gap-2">
          {(['ask', 'assist', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleSetAiMode(mode)}
              className="rounded-md px-3 py-1.5 text-sm capitalize"
              style={{
                backgroundColor: aiMode === mode ? 'var(--color-text)' : 'var(--color-surface)',
                color: aiMode === mode ? 'var(--color-bg)' : 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2" role="region" aria-label="Canvas settings">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Canvas{' '}
          {canvasStatus?.tokenConfigured && canvasStatus?.baseUrlConfigured
            ? '— connected'
            : canvasStatus
              ? '— not connected'
              : ''}
        </span>
        <input
          type="text"
          value={canvasUrlInput}
          onChange={(e) => setCanvasUrlInput(e.target.value)}
          placeholder="uncw.instructure.com"
          aria-label="Canvas URL"
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <div className="flex gap-2">
          <input
            type="password"
            value={canvasTokenInput}
            onChange={(e) => setCanvasTokenInput(e.target.value)}
            placeholder="Canvas access token"
            aria-label="Canvas access token"
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          />
          <button
            type="button"
            onClick={handleSaveCanvas}
            disabled={canvasUrlInput.trim().length === 0 && canvasTokenInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleTestCanvas}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          >
            Test connection
          </button>
          {canvasStatus?.tokenConfigured && (
            <button
              type="button"
              onClick={handleDisconnectCanvas}
              className="rounded-md px-3 py-1.5 text-sm"
              style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            >
              Disconnect
            </button>
          )}
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Generate a token in Canvas under Account → Settings → Approved Integrations. UNCW tokens
          expire after 90 days.
        </span>
        {canvasMessage && <span style={{ color: 'var(--color-text-muted)' }}>{canvasMessage}</span>}
        {canvasError && <span style={{ color: '#F87171' }}>{canvasError}</span>}
      </div>
      <p style={{ color: 'var(--color-text-muted)' }}>SmartLife v{version}</p>
    </div>
  );
}
