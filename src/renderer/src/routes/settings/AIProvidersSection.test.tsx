import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
