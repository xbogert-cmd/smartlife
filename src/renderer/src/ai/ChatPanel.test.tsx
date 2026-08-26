import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPanel } from './ChatPanel';
import type { ChatMessage } from './useConversation';

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `message ${i}`,
  }));
}

function panel(count: number) {
  return (
    <MemoryRouter>
      <ChatPanel
        messages={messages(count)}
        statusLabel={null}
        pendingConfirm={null}
        sending={false}
        apiKeyConfigured={true}
        input=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        onRespondToConfirm={() => {}}
      />
    </MemoryRouter>
  );
}

// jsdom never lays out content, so every element's real scrollHeight is
// always 0 -- stub it on the prototype so the transcript container reports
// something taller than its (also-zero) clientHeight, giving the
// scroll-to-bottom effect something real to move to.
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

function stubScrollHeight(value: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => value });
}

afterEach(() => {
  if (scrollHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
});

describe('ChatPanel scroll position', () => {
  it('scrolls the transcript to the bottom on mount', () => {
    stubScrollHeight(5000);
    const { container } = render(panel(20));
    const scrollable = container.querySelector('.overflow-auto') as HTMLDivElement;
    expect(scrollable.scrollTop).toBe(5000);
  });

  it('scrolls to the bottom again as new messages arrive', () => {
    stubScrollHeight(3000);
    const { container, rerender } = render(panel(2));
    const scrollable = container.querySelector('.overflow-auto') as HTMLDivElement;
    expect(scrollable.scrollTop).toBe(3000);

    stubScrollHeight(9000);
    rerender(panel(3));
    expect(scrollable.scrollTop).toBe(9000);
  });
});

describe('ChatPanel switch notices', () => {
  it('renders a switch-notice message centered and muted, not as a normal chat bubble', () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[
            { id: '1', role: 'assistant', text: 'Partial answer from the first provider' },
            { id: '2', role: 'assistant', text: 'Switched to Gemini — Claude Sonnet 5 was unavailable (credit balance too low).', kind: 'switch-notice' },
            { id: '3', role: 'assistant', text: 'Full fresh answer from Gemini' },
          ]}
          statusLabel={null}
          pendingConfirm={null}
          sending={false}
          apiKeyConfigured={true}
          input=""
          onInputChange={vi.fn()}
          onSubmit={vi.fn()}
          onRespondToConfirm={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/switched to gemini/i)).toBeInTheDocument();
    expect(screen.getByText('Partial answer from the first provider')).toBeInTheDocument();
    expect(screen.getByText('Full fresh answer from Gemini')).toBeInTheDocument();
  });
});
