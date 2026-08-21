import { describe, expect, it } from 'vitest';
import { createSuspendCounter } from './suspend';

describe('createSuspendCounter', () => {
  it('is not suspended initially', () => {
    const counter = createSuspendCounter();
    expect(counter.isSuspended()).toBe(false);
    expect(counter.count()).toBe(0);
  });

  it('suspends on the first acquire', () => {
    const counter = createSuspendCounter();
    counter.acquire();
    expect(counter.isSuspended()).toBe(true);
  });

  it('stays suspended after two acquires and one release', () => {
    const counter = createSuspendCounter();
    counter.acquire();
    counter.acquire();
    counter.release();
    expect(counter.count()).toBe(1);
    expect(counter.isSuspended()).toBe(true);
  });

  it('resumes only when every acquire has been released', () => {
    const counter = createSuspendCounter();
    counter.acquire();
    counter.acquire();
    counter.release();
    counter.release();
    expect(counter.isSuspended()).toBe(false);
  });

  it('never goes below zero on an unmatched release', () => {
    const counter = createSuspendCounter();
    counter.release();
    counter.release();
    expect(counter.count()).toBe(0);
    counter.acquire();
    expect(counter.isSuspended()).toBe(true);
  });

  it('reset clears everything, for a renderer reload', () => {
    const counter = createSuspendCounter();
    counter.acquire();
    counter.acquire();
    counter.reset();
    expect(counter.count()).toBe(0);
    expect(counter.isSuspended()).toBe(false);
  });
});
