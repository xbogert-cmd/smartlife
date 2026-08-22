import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no ResizeObserver. ViewportSlot.test.tsx and Browser.test.tsx
// already stub one locally; HandoffPanel.test.tsx renders ViewportSlot
// indirectly (via HandoffPanel) without stubbing it itself, so provide a
// harmless global default here. Test files that need to assert on resize
// callbacks still install their own FakeResizeObserver, which overrides this.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver;
}

afterEach(() => {
  cleanup();
});
