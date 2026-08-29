import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './ModelPicker';

type StreamEvent = { type: string; from?: string; to?: string; reason?: string };
type StreamCb = (event: StreamEvent) => void;

function mockAi(overrides: Partial<Record<string, unknown>> = {}) {
  // A real ipcRenderer.on supports any number of independent listeners --
  // model this faithfully (unlike a single-slot mock) so a second consumer
  // registering onStreamEvent never clobbers this component's own listener.
  const listeners = new Set<StreamCb>();
  return {
    getCatalog: vi.fn().mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', costRank: 1 },
    ]),
    getRanking: vi.fn().mockResolvedValue([
      { providerId: 'ollama', model: 'llama3.1:8b' },
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    ]),
    getPinnedEntry: vi.fn().mockResolvedValue(null),
    setPinnedEntry: vi.fn().mockResolvedValue(undefined),
    clearPinnedEntry: vi.fn().mockResolvedValue(undefined),
    getApiKeyStatus: vi.fn().mockResolvedValue(true),
    getGeminiKeyStatus: vi.fn().mockResolvedValue(true),
    listOllamaModels: vi.fn().mockResolvedValue([{ name: 'llama3.1:8b' }]),
    onStreamEvent: vi.fn((cb: StreamCb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    __emit: (event: StreamEvent) => listeners.forEach((cb) => cb(event)),
    ...overrides,
  };
}

function install(ai: ReturnType<typeof mockAi>): void {
  (window as unknown as { smartlife: unknown }).smartlife = { ai };
}

describe('ModelPicker', () => {
  beforeEach(() => {
    vi.stubGlobal('window', window);
  });

  it('renders nothing when the ranked list is empty', async () => {
    install(mockAi({ getRanking: vi.fn().mockResolvedValue([]) }));
    const { container } = render(<ModelPicker />);
    await waitFor(() => expect(container.querySelector('select')).toBeNull());
  });

  it('lists Auto plus every ranked entry, defaulting to Auto when nothing is pinned', async () => {
    install(mockAi());
    render(<ModelPicker />);
    const select = await screen.findByLabelText('AI model');
    expect((select as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByRole('option', { name: 'Auto' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Ollama — llama3.1:8b' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Claude Haiku 4.5' })).toBeTruthy();
  });

  it('reflects an already-pinned entry as the selected value', async () => {
    install(mockAi({ getPinnedEntry: vi.fn().mockResolvedValue({ providerId: 'ollama', model: 'llama3.1:8b' }) }));
    render(<ModelPicker />);
    const select = (await screen.findByLabelText('AI model')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('ollama:llama3.1:8b'));
  });

  it('flags a Claude entry with no stored API key', async () => {
    install(mockAi({ getApiKeyStatus: vi.fn().mockResolvedValue(false) }));
    render(<ModelPicker />);
    expect(await screen.findByRole('option', { name: 'Claude Haiku 4.5 — API key missing' })).toBeTruthy();
  });

  it('flags an Ollama entry that has not been pulled locally', async () => {
    install(mockAi({ listOllamaModels: vi.fn().mockResolvedValue([{ name: 'qwen2.5:7b' }]) }));
    render(<ModelPicker />);
    expect(await screen.findByRole('option', { name: 'Ollama — llama3.1:8b — not pulled' })).toBeTruthy();
  });

  it('flags every Ollama entry as offline when Ollama cannot be reached at all', async () => {
    install(mockAi({ listOllamaModels: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }));
    render(<ModelPicker />);
    expect(await screen.findByRole('option', { name: 'Ollama — llama3.1:8b — offline' })).toBeTruthy();
  });

  it('shows the failure reason from a provider-switched event fired against this entry', async () => {
    const ai = mockAi();
    install(ai);
    render(<ModelPicker />);
    await screen.findByLabelText('AI model');
    ai.__emit({ type: 'provider-switched', from: 'Ollama — llama3.1:8b', to: 'Claude Haiku 4.5', reason: 'ECONNREFUSED' });
    expect(await screen.findByRole('option', { name: 'Ollama — llama3.1:8b — ECONNREFUSED' })).toBeTruthy();
  });

  it('pins the selected entry and calls setPinnedEntry with providerId and model split correctly, even for an Ollama tag containing a colon', async () => {
    const ai = mockAi();
    install(ai);
    const user = userEvent.setup();
    render(<ModelPicker />);
    const select = await screen.findByLabelText('AI model');
    await user.selectOptions(select, 'ollama:llama3.1:8b');
    await waitFor(() => expect(ai.setPinnedEntry).toHaveBeenCalledWith({ providerId: 'ollama', model: 'llama3.1:8b' }));
  });

  it('clears the pin and calls clearPinnedEntry when switched back to Auto', async () => {
    const ai = mockAi({ getPinnedEntry: vi.fn().mockResolvedValue({ providerId: 'ollama', model: 'llama3.1:8b' }) });
    install(ai);
    const user = userEvent.setup();
    render(<ModelPicker />);
    const select = (await screen.findByLabelText('AI model')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('ollama:llama3.1:8b'));
    await user.selectOptions(select, 'auto');
    await waitFor(() => expect(ai.clearPinnedEntry).toHaveBeenCalled());
  });
});
