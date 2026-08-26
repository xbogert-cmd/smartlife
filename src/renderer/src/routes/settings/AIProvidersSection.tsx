import { useEffect, useState } from 'react';

interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
}
interface RankingEntry {
  providerId: 'anthropic' | 'gemini' | 'ollama';
  model: string;
}
interface OllamaModelInfo {
  name: string;
}
interface PinnedEntry {
  providerId: 'anthropic' | 'gemini' | 'ollama';
  model: string;
}

const KNOWN_GOOD_FOR_TOOLS_PREFIXES = ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral-nemo'];

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

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ranking, setRankingState] = useState<RankingEntry[]>([]);
  const [pinned, setPinnedState] = useState<PinnedEntry | null>(null);
  const [addProviderId, setAddProviderId] = useState<'anthropic' | 'gemini' | 'ollama'>('anthropic');
  const [addModel, setAddModel] = useState('');

  useEffect(() => {
    window.smartlife.ai.getCatalog().then(setCatalog);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getRanking().then(setRankingState);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getPinnedEntry().then(setPinnedState);
  }, []);

  useEffect(() => {
    window.smartlife.ai.listOllamaModels().then(setOllamaModels).catch(() => setOllamaModels([]));
  }, []);

  function modelChoicesFor(providerId: 'anthropic' | 'gemini' | 'ollama'): Array<{ model: string; label: string }> {
    if (providerId === 'ollama') {
      return ollamaModels.map((m) => ({
        model: m.name,
        label: KNOWN_GOOD_FOR_TOOLS_PREFIXES.some((p) => m.name.toLowerCase().startsWith(p))
          ? m.name
          : `${m.name} (may not support tools well)`,
      }));
    }
    return catalog.filter((entry) => entry.providerId === providerId).map((entry) => ({ model: entry.model, label: entry.displayName }));
  }

  function displayNameForEntry(entry: RankingEntry): string {
    if (entry.providerId === 'ollama') return `Ollama — ${entry.model}`;
    return catalog.find((c) => c.providerId === entry.providerId && c.model === entry.model)?.displayName ?? `${entry.providerId} — ${entry.model}`;
  }

  async function persistRanking(next: RankingEntry[]): Promise<void> {
    setRankingState(next);
    await window.smartlife.ai.setRanking(next);
  }

  async function handleAddEntry(): Promise<void> {
    if (addModel.length === 0) return;
    await persistRanking([...ranking, { providerId: addProviderId, model: addModel }]);
    setAddModel('');
  }

  async function handleRemoveEntry(index: number): Promise<void> {
    await persistRanking(ranking.filter((_, i) => i !== index));
  }

  async function handleMoveEntry(index: number, direction: -1 | 1): Promise<void> {
    const target = index + direction;
    if (target < 0 || target >= ranking.length) return;
    const next = [...ranking];
    [next[index], next[target]] = [next[target], next[index]];
    await persistRanking(next);
  }

  async function handleSetPin(entry: PinnedEntry | null): Promise<void> {
    if (entry === null) {
      await window.smartlife.ai.clearPinnedEntry();
    } else {
      await window.smartlife.ai.setPinnedEntry(entry);
    }
    setPinnedState(entry);
  }

  async function handleRetry(entry: RankingEntry): Promise<void> {
    await window.smartlife.ai.retryProviderEntry(entry.providerId, entry.model);
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

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Fallback order</span>
        <ol className="flex flex-col gap-1">
          {ranking.map((entry, index) => (
            <li key={`${entry.providerId}-${entry.model}`} className="flex items-center gap-2">
              <span style={{ color: 'var(--color-text)' }}>
                {index + 1}. {displayNameForEntry(entry)}
              </span>
              <button
                type="button"
                onClick={() => handleMoveEntry(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${displayNameForEntry(entry)} up`}
                className="rounded-md px-2 py-1 text-xs"
                style={secondaryButtonStyle}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => handleMoveEntry(index, 1)}
                disabled={index === ranking.length - 1}
                aria-label={`Move ${displayNameForEntry(entry)} down`}
                className="rounded-md px-2 py-1 text-xs"
                style={secondaryButtonStyle}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => handleRemoveEntry(index)}
                aria-label={`Remove ${displayNameForEntry(entry)}`}
                className="rounded-md px-2 py-1 text-xs"
                style={secondaryButtonStyle}
              >
                Remove
              </button>
              <button type="button" onClick={() => handleRetry(entry)} className="rounded-md px-2 py-1 text-xs" style={secondaryButtonStyle}>
                Retry
              </button>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <select
            value={addProviderId}
            onChange={(e) => {
              setAddProviderId(e.target.value as typeof addProviderId);
              setAddModel('');
            }}
            aria-label="Provider to add"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          >
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="ollama">Ollama</option>
          </select>
          <select value={addModel} onChange={(e) => setAddModel(e.target.value)} aria-label="Model to add" className="rounded-md px-3 py-1.5 text-sm" style={inputStyle}>
            <option value="">Select a model…</option>
            {modelChoicesFor(addProviderId).map((choice) => (
              <option key={choice.model} value={choice.model}>
                {choice.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleAddEntry} disabled={addModel.length === 0} className="rounded-md px-3 py-1.5 text-sm" style={primaryButtonStyle}>
            Add to list
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Active model</span>
        <select
          value={pinned ? `${pinned.providerId}:${pinned.model}` : 'auto'}
          onChange={(e) => {
            if (e.target.value === 'auto') {
              handleSetPin(null);
              return;
            }
            const [providerId, model] = e.target.value.split(':') as [PinnedEntry['providerId'], string];
            handleSetPin({ providerId, model });
          }}
          aria-label="Active model"
          className="rounded-md px-3 py-1.5 text-sm"
          style={inputStyle}
        >
          <option value="auto">Auto (use the fallback order above)</option>
          {ranking.map((entry) => (
            <option key={`${entry.providerId}-${entry.model}`} value={`${entry.providerId}:${entry.model}`}>
              {displayNameForEntry(entry)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
