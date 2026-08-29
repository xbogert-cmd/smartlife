import { useEffect, useState } from 'react';

interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
}

interface RankingEntry {
  providerId: 'anthropic' | 'gemini' | 'ollama';
  model: string;
}

type PinnedEntry = RankingEntry;

function entryKey(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

function parseEntryKey(key: string): PinnedEntry {
  const [providerId, ...rest] = key.split(':');
  // Ollama model tags contain ':' themselves (e.g. "llama3.1:8b") -- rejoin
  // everything after the first segment instead of splitting naively.
  return { providerId: providerId as PinnedEntry['providerId'], model: rest.join(':') };
}

/**
 * A model picker in the chat header, mirroring Settings' fallback-order
 * builder but scoped to "pick what answers right now" rather than
 * "configure the list". Rendered once inside ChatPanel so it appears in
 * both the AIDock and the /ai route for free (they share this component).
 *
 * Status per entry is computed from signals already available rather than
 * live-probing each provider on every render: credential presence (Claude,
 * Gemini), the locally-pulled Ollama model list, and this session's own
 * `provider-switched` events (which already carry the failure reason --
 * see fallback.ts) captured via a dedicated listener.
 */
export function ModelPicker(): React.JSX.Element | null {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [ranking, setRanking] = useState<RankingEntry[]>([]);
  const [pinned, setPinned] = useState<PinnedEntry | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [claudeKeyOk, setClaudeKeyOk] = useState(true);
  const [geminiKeyOk, setGeminiKeyOk] = useState(true);
  const [failures, setFailures] = useState<Record<string, string>>({});

  useEffect(() => {
    window.smartlife.ai.getCatalog().then(setCatalog).catch(() => {});
    window.smartlife.ai.getRanking().then(setRanking).catch(() => {});
    window.smartlife.ai.getPinnedEntry().then(setPinned).catch(() => {});
    window.smartlife.ai.getApiKeyStatus().then(setClaudeKeyOk).catch(() => {});
    window.smartlife.ai.getGeminiKeyStatus().then(setGeminiKeyOk).catch(() => {});
    window.smartlife.ai
      .listOllamaModels()
      .then((models) => setOllamaModels(models.map((m) => m.name)))
      .catch(() => setOllamaModels(null));
  }, []);

  useEffect(() => {
    return window.smartlife.ai.onStreamEvent((event) => {
      if (event.type === 'provider-switched' && event.from) {
        setFailures((prev) => ({ ...prev, [event.from as string]: event.reason ?? 'unavailable' }));
      }
    });
  }, []);

  function displayNameFor(entry: RankingEntry): string {
    if (entry.providerId === 'ollama') return `Ollama — ${entry.model}`;
    return (
      catalog.find((c) => c.providerId === entry.providerId && c.model === entry.model)?.displayName ??
      `${entry.providerId} — ${entry.model}`
    );
  }

  function statusSuffixFor(entry: RankingEntry): string {
    if (entry.providerId === 'anthropic' && !claudeKeyOk) return ' — API key missing';
    if (entry.providerId === 'gemini' && !geminiKeyOk) return ' — API key missing';
    if (entry.providerId === 'ollama') {
      if (ollamaModels === null) return ' — offline';
      if (!ollamaModels.includes(entry.model)) return ' — not pulled';
    }
    const failure = failures[displayNameFor(entry)];
    if (failure) return ` — ${failure}`;
    return '';
  }

  if (ranking.length === 0) return null;

  const value = pinned ? entryKey(pinned.providerId, pinned.model) : 'auto';

  async function handleChange(next: string): Promise<void> {
    if (next === 'auto') {
      await window.smartlife.ai.clearPinnedEntry();
      setPinned(null);
      return;
    }
    const entry = parseEntryKey(next);
    await window.smartlife.ai.setPinnedEntry(entry);
    setPinned(entry);
  }

  return (
    <select
      aria-label="AI model"
      value={value}
      onChange={(e) => {
        void handleChange(e.target.value);
      }}
      className="rounded-md px-2 py-1 text-xs"
      style={{
        backgroundColor: 'var(--color-surface)',
        color: 'var(--color-text)',
        border: '1px solid var(--color-border)',
        maxWidth: 220,
      }}
    >
      <option value="auto">Auto</option>
      {ranking.map((entry) => (
        <option key={entryKey(entry.providerId, entry.model)} value={entryKey(entry.providerId, entry.model)}>
          {displayNameFor(entry)}
          {statusSuffixFor(entry)}
        </option>
      ))}
    </select>
  );
}
