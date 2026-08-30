import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestConfirmation, resolveConfirmation, getPendingConfirmation, setConfirmationBroadcaster } from './confirmations';

describe('confirmation round-trip', () => {
  it('resolves true when resolveConfirmation is called with approved=true', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe('set_theme');
    resolveConfirmation(sent[0].id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when resolveConfirmation is called with approved=false', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'clear_conversation_history', 'Clear history');
    resolveConfirmation(sent[0].id, false);
    await expect(promise).resolves.toBe(false);
  });

  it('ignores resolveConfirmation for an unknown id without throwing', () => {
    expect(() => resolveConfirmation('unknown-id', true)).not.toThrow();
  });
});

describe('confirmation timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-resolves to false if resolveConfirmation is never called', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(promise).resolves.toBe(false);
  });

  it('does not double-resolve or throw when the timeout fires after resolveConfirmation already settled it', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');

    resolveConfirmation(sent[0].id, true);
    await expect(promise).resolves.toBe(true);

    expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
    await expect(promise).resolves.toBe(true);
  });
});

describe('custom timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the default 120-second timeout when none is given', async () => {
    const promise = requestConfirmation(() => {}, 'set_theme', 'Set theme to dark');
    await vi.advanceTimersByTimeAsync(119_999);
    // Not yet resolved.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(promise).resolves.toBe(false);
  });

  it('honors a custom timeout, e.g. 24 hours for browser action tools', async () => {
    const promise = requestConfirmation(() => {}, 'browser_click', 'Click Submit', 24 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(120_001); // past the old default
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await expect(promise).resolves.toBe(false);
  });
});

describe('getPendingConfirmation', () => {
  it('returns null when nothing is pending', () => {
    expect(getPendingConfirmation()).toBeNull();
  });

  it('returns the current pending confirmation while one is outstanding', () => {
    const promise = requestConfirmation(() => {}, 'browser_click', 'Click Submit');
    const pending = getPendingConfirmation();
    expect(pending).toMatchObject({ toolName: 'browser_click', description: 'Click Submit' });
    resolveConfirmation(pending!.id, true);
    return promise;
  });

  it('returns null again once the pending confirmation resolves', async () => {
    const promise = requestConfirmation(() => {}, 'browser_click', 'Click Submit');
    const pending = getPendingConfirmation();
    resolveConfirmation(pending!.id, true);
    await promise;
    expect(getPendingConfirmation()).toBeNull();
  });
});

describe('confirmation resolution broadcast', () => {
  it('calls the registered broadcaster with the id when resolved explicitly', async () => {
    const broadcast = vi.fn();
    setConfirmationBroadcaster(broadcast);
    const promise = requestConfirmation(() => {}, 'browser_click', 'Click Submit');
    const pending = getPendingConfirmation();
    resolveConfirmation(pending!.id, true);
    await promise;
    expect(broadcast).toHaveBeenCalledWith(pending!.id);
    setConfirmationBroadcaster(() => {}); // reset for other tests in this file
  });

  it('calls the registered broadcaster when resolved by timeout too', async () => {
    vi.useFakeTimers();
    const broadcast = vi.fn();
    setConfirmationBroadcaster(broadcast);
    const promise = requestConfirmation(() => {}, 'browser_click', 'Click Submit');
    const pending = getPendingConfirmation();
    await vi.advanceTimersByTimeAsync(120_000);
    await promise;
    expect(broadcast).toHaveBeenCalledWith(pending!.id);
    setConfirmationBroadcaster(() => {});
    vi.useRealTimers();
  });
});

describe('concurrent confirmations queue instead of racing', () => {
  it('does not send the second confirmation until the first resolves', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const send = (payload: { id: string; toolName: string; description: string }) => sent.push(payload);

    const first = requestConfirmation(send, 'canvas_upcoming_assignments', 'Read upcoming assignments');
    const second = requestConfirmation(send, 'calendar_list_events', 'Read calendar events');

    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe('canvas_upcoming_assignments');

    resolveConfirmation(sent[0].id, true);
    await first;

    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe('calendar_list_events');

    resolveConfirmation(sent[1].id, true);
    await second;
  });

  it('still shows only one confirmation at a time via getPendingConfirmation while two are queued', () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const send = (payload: { id: string; toolName: string; description: string }) => sent.push(payload);

    const first = requestConfirmation(send, 'canvas_upcoming_assignments', 'Read upcoming assignments');
    requestConfirmation(send, 'calendar_list_events', 'Read calendar events');

    expect(getPendingConfirmation()).toMatchObject({ toolName: 'canvas_upcoming_assignments' });

    resolveConfirmation(sent[0].id, true);
    return first;
  });
});
