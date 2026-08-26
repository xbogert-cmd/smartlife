import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AIProvidersSection } from './AIProvidersSection';

beforeEach(() => {
  (window as unknown as { smartlife: typeof window.smartlife }).smartlife = {
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
      getGeminiKeyStatus: vi.fn().mockResolvedValue(false),
      setGeminiKey: vi.fn().mockResolvedValue(undefined),
      clearGeminiKey: vi.fn().mockResolvedValue(undefined),
      getOllamaEndpoint: vi.fn().mockResolvedValue('http://localhost:11434'),
      setOllamaEndpoint: vi.fn().mockResolvedValue(undefined),
      listOllamaModels: vi.fn().mockResolvedValue([]),
      getCatalog: vi.fn().mockResolvedValue([
        { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
        { providerId: 'gemini', model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', costRank: 1 },
      ]),
      getRanking: vi.fn().mockResolvedValue([]),
      setRanking: vi.fn().mockResolvedValue(undefined),
      getPinnedEntry: vi.fn().mockResolvedValue(null),
      setPinnedEntry: vi.fn().mockResolvedValue(undefined),
      clearPinnedEntry: vi.fn().mockResolvedValue(undefined),
      retryProviderEntry: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof window.smartlife;
});

describe('AIProvidersSection — credentials', () => {
  it('renders its own labeled region', async () => {
    render(<AIProvidersSection />);
    expect(await screen.findByRole('region', { name: 'AI Providers settings' })).toBeInTheDocument();
  });

  it('shows not-connected status for Claude and Gemini, and saves a Claude key', async () => {
    render(<AIProvidersSection />);
    expect(await screen.findByText(/claude api key.*not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini api key.*not connected/i)).toBeInTheDocument();

    const apiKeyInput = screen.getByLabelText('Claude API key');
    await userEvent.type(apiKeyInput, 'sk-ant-test');
    await userEvent.click(screen.getByRole('button', { name: 'Save Claude key' }));

    await waitFor(() => expect(window.smartlife.ai.setApiKey).toHaveBeenCalledWith('sk-ant-test'));
    expect(await screen.findByText(/claude api key.*— connected/i)).toBeInTheDocument();
  });

  it('saves and clears a Gemini key', async () => {
    render(<AIProvidersSection />);
    await screen.findByText(/gemini api key.*not connected/i);

    const geminiInput = screen.getByLabelText('Gemini API key');
    await userEvent.type(geminiInput, 'gm-test-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Gemini key' }));
    await waitFor(() => expect(window.smartlife.ai.setGeminiKey).toHaveBeenCalledWith('gm-test-key'));
    expect(await screen.findByText(/gemini api key.*— connected/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect Gemini' }));
    await waitFor(() => expect(window.smartlife.ai.clearGeminiKey).toHaveBeenCalled());
  });

  it('loads and saves the Ollama endpoint', async () => {
    render(<AIProvidersSection />);
    await waitFor(() => expect(screen.getByLabelText('Ollama endpoint')).toHaveValue('http://localhost:11434'));

    const endpointInput = screen.getByLabelText('Ollama endpoint');
    await userEvent.clear(endpointInput);
    await userEvent.type(endpointInput, 'http://192.168.1.50:11434');
    await userEvent.click(screen.getByRole('button', { name: 'Save Ollama endpoint' }));
    await waitFor(() => expect(window.smartlife.ai.setOllamaEndpoint).toHaveBeenCalledWith('http://192.168.1.50:11434'));
  });

  it('reports the model count on a successful Ollama connection test', async () => {
    vi.mocked(window.smartlife.ai.listOllamaModels).mockResolvedValue([{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }]);
    render(<AIProvidersSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Test Ollama connection' }));
    expect(await screen.findByText(/connected — 2 model/i)).toBeInTheDocument();
  });

  it('reports a clear error when Ollama is unreachable', async () => {
    vi.mocked(window.smartlife.ai.listOllamaModels).mockRejectedValue(new Error('fetch failed'));
    render(<AIProvidersSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Test Ollama connection' }));
    expect(await screen.findByText(/couldn.t reach ollama/i)).toBeInTheDocument();
  });
});

describe('AIProvidersSection — fallback ranking', () => {
  it('adds a catalog entry to the ranked list', async () => {
    render(<AIProvidersSection />);
    await screen.findByText(/claude api key/i);

    await userEvent.selectOptions(screen.getByLabelText('Provider to add'), 'gemini');
    await userEvent.selectOptions(screen.getByLabelText('Model to add'), 'gemini-2.5-flash');
    await userEvent.click(screen.getByRole('button', { name: 'Add to list' }));

    await waitFor(() =>
      expect(window.smartlife.ai.setRanking).toHaveBeenCalledWith([{ providerId: 'gemini', model: 'gemini-2.5-flash' }])
    );
    // Note: deviation from the brief — scoped to the ranked list because "Gemini 2.5 Flash" also
    // legitimately appears as an <option> in the "Model to add" and "Active model" selects, so an
    // unscoped screen.findByText matches multiple elements.
    expect(await within(screen.getByRole('list')).findByText(/gemini 2.5 flash/i)).toBeInTheDocument();
  });

  it('reorders the list with the up/down controls', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    render(<AIProvidersSection />);
    // Note: deviation from the brief — scoped to the ranked list, same reason as above.
    await within(screen.getByRole('list')).findByText(/claude sonnet 5/i);

    await userEvent.click(screen.getByRole('button', { name: /move gemini 2.5 flash up/i }));

    await waitFor(() =>
      expect(window.smartlife.ai.setRanking).toHaveBeenCalledWith([
        { providerId: 'gemini', model: 'gemini-2.5-flash' },
        { providerId: 'anthropic', model: 'claude-sonnet-5' },
      ])
    );
  });

  it('removes an entry from the list', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    // Note: deviation from the brief — scoped to the ranked list, same reason as above.
    await within(screen.getByRole('list')).findByText(/claude sonnet 5/i);

    await userEvent.click(screen.getByRole('button', { name: /remove claude sonnet 5/i }));

    await waitFor(() => expect(window.smartlife.ai.setRanking).toHaveBeenCalledWith([]));
  });

  it('warns inline for an Ollama model not known to support tools well, without blocking it', async () => {
    vi.mocked(window.smartlife.ai.listOllamaModels).mockResolvedValue([{ name: 'tinyllama' }]);
    render(<AIProvidersSection />);
    await screen.findByText(/claude api key/i);

    await userEvent.selectOptions(screen.getByLabelText('Provider to add'), 'ollama');
    expect(screen.getByRole('option', { name: /tinyllama.*may not support tools well/i })).toBeInTheDocument();
  });

  it('pins a specific entry as the active model instead of Auto', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    // Note: deviation from the brief — scoped to the ranked list, same reason as above.
    await within(screen.getByRole('list')).findByText(/claude sonnet 5/i);

    await userEvent.selectOptions(screen.getByLabelText('Active model'), 'anthropic:claude-sonnet-5');

    await waitFor(() =>
      expect(window.smartlife.ai.setPinnedEntry).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-sonnet-5' })
    );
  });

  it('clears the pin back to Auto', async () => {
    vi.mocked(window.smartlife.ai.getPinnedEntry).mockResolvedValue({ providerId: 'anthropic', model: 'claude-sonnet-5' });
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    await waitFor(() => expect(screen.getByLabelText('Active model')).toHaveValue('anthropic:claude-sonnet-5'));

    await userEvent.selectOptions(screen.getByLabelText('Active model'), 'auto');

    await waitFor(() => expect(window.smartlife.ai.clearPinnedEntry).toHaveBeenCalled());
  });

  it('retries a failed entry', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    // Note: deviation from the brief — scoped to the ranked list, same reason as above.
    await within(screen.getByRole('list')).findByText(/claude sonnet 5/i);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(window.smartlife.ai.retryProviderEntry).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5');
  });
});
