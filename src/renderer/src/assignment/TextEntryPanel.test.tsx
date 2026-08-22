import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextEntryPanel } from './TextEntryPanel';

const saveDraft = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  saveDraft.mockClear();
  (window as unknown as { smartlife: unknown }).smartlife = { canvas: { saveDraft } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TextEntryPanel', () => {
  it('starts from the saved draft', () => {
    render(
      <TextEntryPanel assignmentId={10} initialDraft="half written" isDiscussion={false} onSubmit={() => {}} />
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('half written');
  });

  it('starts empty when there is no draft', () => {
    render(<TextEntryPanel assignmentId={10} initialDraft={null} isDiscussion={false} onSubmit={() => {}} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not save on every keystroke', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<TextEntryPanel assignmentId={10} initialDraft={null} isDiscussion={false} onSubmit={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'hello');
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('saves the draft after the debounce elapses', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<TextEntryPanel assignmentId={10} initialDraft={null} isDiscussion={false} onSubmit={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'hello');
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveDraft).toHaveBeenCalledWith(10, 'hello');
  });

  it('does not save the initial draft back on mount', async () => {
    render(
      <TextEntryPanel assignmentId={10} initialDraft="already saved" isDiscussion={false} onSubmit={() => {}} />
    );
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('hands the text up on submit', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSubmit = vi.fn();
    render(
      <TextEntryPanel assignmentId={10} initialDraft="my answer" isDiscussion={false} onSubmit={onSubmit} />
    );
    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith('my answer');
  });

  it('will not submit empty text', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSubmit = vi.fn();
    render(<TextEntryPanel assignmentId={10} initialDraft="" isDiscussion={false} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('labels the button as posting for a discussion', () => {
    render(<TextEntryPanel assignmentId={10} initialDraft="x" isDiscussion onSubmit={() => {}} />);
    expect(screen.getByRole('button', { name: /post/i })).toBeTruthy();
  });

  it('disables submission while a submit is in flight', () => {
    render(
      <TextEntryPanel assignmentId={10} initialDraft="x" isDiscussion={false} disabled onSubmit={() => {}} />
    );
    expect((screen.getByRole('button', { name: /submit/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
