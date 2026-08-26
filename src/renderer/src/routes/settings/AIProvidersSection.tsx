import { useEffect, useState } from 'react';

const inputStyle = {
  backgroundColor: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
};
const primaryButtonStyle = { backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' };
const secondaryButtonStyle = { backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' };

export function AIProvidersSection() {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyError, setApiKeyError] = useState('');

  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [geminiKeyConfigured, setGeminiKeyConfigured] = useState<boolean | null>(null);
  const [geminiKeyError, setGeminiKeyError] = useState('');

  const [ollamaEndpointInput, setOllamaEndpointInput] = useState('');
  const [ollamaMessage, setOllamaMessage] = useState('');
  const [ollamaError, setOllamaError] = useState('');

  useEffect(() => {
    window.smartlife.ai.getApiKeyStatus().then(setApiKeyConfigured);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getGeminiKeyStatus().then(setGeminiKeyConfigured);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getOllamaEndpoint().then(setOllamaEndpointInput);
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

  async function handleSaveGeminiKey(): Promise<void> {
    setGeminiKeyError('');
    try {
      await window.smartlife.ai.setGeminiKey(geminiKeyInput);
      setGeminiKeyInput('');
      setGeminiKeyConfigured(true);
    } catch (err) {
      setGeminiKeyError(err instanceof Error ? err.message : 'Failed to save key.');
    }
  }

  async function handleClearGeminiKey(): Promise<void> {
    await window.smartlife.ai.clearGeminiKey();
    setGeminiKeyConfigured(false);
  }

  async function handleSaveOllamaEndpoint(): Promise<void> {
    setOllamaError('');
    setOllamaMessage('');
    try {
      await window.smartlife.ai.setOllamaEndpoint(ollamaEndpointInput);
      setOllamaMessage('Saved.');
    } catch (err) {
      setOllamaError(err instanceof Error ? err.message : 'Failed to save endpoint.');
    }
  }

  async function handleTestOllama(): Promise<void> {
    setOllamaError('');
    setOllamaMessage('Testing…');
    try {
      const models = await window.smartlife.ai.listOllamaModels();
      setOllamaMessage(
        models.length > 0 ? `Connected — ${models.length} model(s) available.` : 'Connected, but no models are pulled yet.'
      );
    } catch {
      setOllamaMessage('');
      setOllamaError("Couldn't reach Ollama — is it running?");
    }
  }

  return (
    <div className="flex flex-col gap-6" role="region" aria-label="AI Providers settings">
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
            aria-label="Claude API key"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={apiKeyInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={primaryButtonStyle}
          >
            Save Claude key
          </button>
        </div>
        {apiKeyError && <span style={{ color: '#F87171' }}>{apiKeyError}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Gemini API key {geminiKeyConfigured === true ? '— connected' : geminiKeyConfigured === false ? '— not connected' : ''}
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            value={geminiKeyInput}
            onChange={(e) => setGeminiKeyInput(e.target.value)}
            placeholder="AIza..."
            aria-label="Gemini API key"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={handleSaveGeminiKey}
            disabled={geminiKeyInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={primaryButtonStyle}
          >
            Save Gemini key
          </button>
          {geminiKeyConfigured === true && (
            <button type="button" onClick={handleClearGeminiKey} className="rounded-md px-3 py-1.5 text-sm" style={secondaryButtonStyle}>
              Disconnect Gemini
            </button>
          )}
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Get a free key at Google AI Studio (aistudio.google.com).
        </span>
        {geminiKeyError && <span style={{ color: '#F87171' }}>{geminiKeyError}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Ollama endpoint</span>
        <div className="flex gap-2">
          <input
            type="text"
            value={ollamaEndpointInput}
            onChange={(e) => setOllamaEndpointInput(e.target.value)}
            placeholder="http://localhost:11434"
            aria-label="Ollama endpoint"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button type="button" onClick={handleSaveOllamaEndpoint} className="rounded-md px-3 py-1.5 text-sm" style={primaryButtonStyle}>
            Save Ollama endpoint
          </button>
          <button type="button" onClick={handleTestOllama} className="rounded-md px-3 py-1.5 text-sm" style={secondaryButtonStyle}>
            Test Ollama connection
          </button>
        </div>
        {ollamaMessage && <span style={{ color: 'var(--color-text-muted)' }}>{ollamaMessage}</span>}
        {ollamaError && <span style={{ color: '#F87171' }}>{ollamaError}</span>}
      </div>
    </div>
  );
}
