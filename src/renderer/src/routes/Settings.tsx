import { useEffect, useState } from 'react';
import { CalendarToggles } from '../calendar/CalendarToggles';
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
  const [calendarStatus, setCalendarStatus] = useState<{
    clientConfigured: boolean;
    connected: boolean;
    accountEmail: string | null;
  } | null>(null);
  const [googleCalendars, setGoogleCalendars] = useState<
    Array<{ id: string; summary: string; backgroundColor: string | null; isPrimary: boolean; enabled: boolean }>
  >([]);
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [calendarMessage, setCalendarMessage] = useState('');
  const [calendarError, setCalendarError] = useState('');

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
    void refreshCalendarState();
  }, []);

  async function refreshCalendarState(): Promise<void> {
    setCalendarStatus((await window.smartlife.calendar.getStatus()) as never);
    setGoogleCalendars((await window.smartlife.calendar.listCalendars()) as never);
  }

  async function handleSaveGoogleClient(): Promise<void> {
    setCalendarError('');
    const result = await window.smartlife.calendar.setClientConfig(clientIdInput, clientSecretInput);
    if (!result.ok) {
      setCalendarError(result.error ?? 'Could not save the client credentials.');
      return;
    }
    setClientSecretInput('');
    setCalendarMessage('Client credentials saved.');
    await refreshCalendarState();
  }

  async function handleConnectGoogle(): Promise<void> {
    setCalendarError('');
    setCalendarMessage('Finish signing in in your browser…');
    const result = await window.smartlife.calendar.connect();
    if (!result.ok) {
      setCalendarMessage('');
      setCalendarError(result.error ?? 'Could not connect to Google.');
      return;
    }
    setCalendarMessage('Connected.');
    await refreshCalendarState();
  }

  async function handleDisconnectGoogle(): Promise<void> {
    await window.smartlife.calendar.disconnect();
    setCalendarMessage('Disconnected.');
    await refreshCalendarState();
  }

  async function handleToggleCalendar(calendarId: string, enabled: boolean): Promise<void> {
    setGoogleCalendars((await window.smartlife.calendar.setCalendarEnabled(calendarId, enabled)) as never);
  }

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
      <div className="flex flex-col gap-2" role="region" aria-label="Google Calendar settings">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Google Calendar{' '}
          {calendarStatus?.connected
            ? `— connected as ${calendarStatus.accountEmail ?? 'your account'}`
            : calendarStatus
              ? '— not connected'
              : ''}
        </span>
        <input
          type="text"
          value={clientIdInput}
          onChange={(e) => setClientIdInput(e.target.value)}
          placeholder="123-abc.apps.googleusercontent.com"
          aria-label="Google Client ID"
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <input
          type="password"
          value={clientSecretInput}
          onChange={(e) => setClientSecretInput(e.target.value)}
          placeholder="Client secret"
          aria-label="Google Client Secret"
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <div className="flex gap-2">
          <button type="button" onClick={() => void handleSaveGoogleClient()} className="rounded-md px-3 py-1.5 text-sm" style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}>
            Save
          </button>
          <button type="button" onClick={() => void handleConnectGoogle()} className="rounded-md px-3 py-1.5 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            Connect
          </button>
          <button type="button" onClick={() => void handleDisconnectGoogle()} className="rounded-md px-3 py-1.5 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            Disconnect
          </button>
        </div>
        {calendarMessage.length > 0 && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{calendarMessage}</span>}
        {calendarError.length > 0 && <span role="alert" className="text-xs" style={{ color: '#EF4444' }}>{calendarError}</span>}
        {calendarStatus?.connected === true && (
          <CalendarToggles calendars={googleCalendars} onToggle={(id, enabled) => void handleToggleCalendar(id, enabled)} />
        )}
      </div>
      <p style={{ color: 'var(--color-text-muted)' }}>SmartLife v{version}</p>
    </div>
  );
}
