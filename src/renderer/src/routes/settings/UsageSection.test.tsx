import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UsageSection } from './UsageSection';

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', {
    value: { ai: { getUsageSummary: vi.fn() } },
    writable: true,
    configurable: true,
  });
});

describe('UsageSection', () => {
  it('renders one row per provider/model with tokens and estimated cost', async () => {
    (window.smartlife.ai.getUsageSummary as ReturnType<typeof vi.fn>).mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 1500, outputTokens: 500, estimatedCostUsd: 0.012 },
      { providerId: 'ollama', model: 'llama3.1', displayName: 'llama3.1', inputTokens: 10000, outputTokens: 8000, estimatedCostUsd: 0 },
    ]);
    render(<UsageSection />);

    expect(await screen.findByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    // Total (0.012 + 0) coincidentally equals this row's own cost, so both cells render
    // the same text — assert at least one match instead of requiring uniqueness.
    expect(screen.getAllByText('$0.012').length).toBeGreaterThan(0);
    expect(screen.getByText('llama3.1')).toBeInTheDocument();
    expect(screen.getByText('$0.000')).toBeInTheDocument();
  });

  it('shows a totals row summing estimated cost across all providers', async () => {
    (window.smartlife.ai.getUsageSummary as ReturnType<typeof vi.fn>).mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 1000, outputTokens: 1000, estimatedCostUsd: 0.01 },
      { providerId: 'gemini', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokens: 1000, outputTokens: 1000, estimatedCostUsd: 0.02 },
    ]);
    render(<UsageSection />);

    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getByText('$0.030')).toBeInTheDocument();
  });

  it('shows nothing has been used yet when the summary is empty', async () => {
    (window.smartlife.ai.getUsageSummary as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(<UsageSection />);

    expect(await screen.findByText('No usage yet.')).toBeInTheDocument();
  });
});
