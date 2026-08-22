import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubmitConfirm } from './SubmitConfirm';

const suspend = vi.fn(async () => {});
const resume = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { smartlife: unknown }).smartlife = {
    browser: { suspend, resume },
  };
});

describe('SubmitConfirm', () => {
  it('suspends the browser view while mounted and resumes on unmount', () => {
    const { unmount } = render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'text', body: 'x' }}
        isDiscussion={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(suspend).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();

    unmount();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('shows the full text untruncated', () => {
    const long = 'a'.repeat(3000);
    render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'text', body: long }}
        isDiscussion={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText(long)).toBeTruthy();
  });

  it('names the assignment', () => {
    render(
      <SubmitConfirm
        assignmentName="Chapter 4 Homework"
        input={{ kind: 'text', body: 'x' }}
        isDiscussion={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText(/Chapter 4 Homework/)).toBeTruthy();
  });

  it('warns that a discussion post is public and undeletable', () => {
    render(
      <SubmitConfirm
        assignmentName="Week 1"
        input={{ kind: 'discussion', message: 'hello' }}
        isDiscussion
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText(/whole class/i)).toBeTruthy();
    expect(screen.getByText(/delete/i)).toBeTruthy();
  });

  it('does not show the discussion warning for a normal submission', () => {
    render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'text', body: 'x' }}
        isDiscussion={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.queryByText(/whole class/i)).toBeNull();
  });

  it('shows the resolved filename and size for a file submission', () => {
    render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'file', filePath: '/Users/a/essay.pdf' }}
        isDiscussion={false}
        fileName="essay.pdf"
        fileSize={2048}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText(/essay\.pdf/)).toBeTruthy();
    expect(screen.getByText(/2,048 bytes|2 KB/)).toBeTruthy();
  });

  it('calls onConfirm when confirmed', async () => {
    const onConfirm = vi.fn();
    render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'text', body: 'x' }}
        isDiscussion={false}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /submit to canvas/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when cancelled', async () => {
    const onCancel = vi.fn();
    render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'text', body: 'x' }}
        isDiscussion={false}
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('is a dialog', () => {
    render(
      <SubmitConfirm
        assignmentName="Ch 4"
        input={{ kind: 'text', body: 'x' }}
        isDiscussion={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByRole('dialog', { name: /confirm submission/i })).toBeTruthy();
  });
});
