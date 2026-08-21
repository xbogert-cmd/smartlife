import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadPrompt } from './DownloadPrompt';
import type { BrowserDownloadRequest } from './types';

let emit: ((request: BrowserDownloadRequest) => void) | null = null;
const respondToDownload = vi.fn(async () => {});
const suspend = vi.fn(async () => {});
const resume = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  emit = null;
  (window as unknown as { smartlife: unknown }).smartlife = {
    browser: {
      respondToDownload,
      suspend,
      resume,
      onDownloadRequest: (cb: (request: BrowserDownloadRequest) => void) => {
        emit = cb;
        return () => {};
      },
    },
  };
});

const request: BrowserDownloadRequest = {
  id: 'download-1',
  filename: 'syllabus.pdf',
  sizeBytes: 52428800,
  sourceUrl: 'https://uncw.edu/syllabus.pdf',
};

describe('DownloadPrompt', () => {
  it('renders nothing until a download is requested', () => {
    const { container } = render(<DownloadPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the file, its size, and its source', async () => {
    render(<DownloadPrompt />);
    await Promise.resolve(emit?.(request));
    const dialog = await screen.findByRole('dialog', { name: 'Download file' });
    expect(dialog).toHaveTextContent('syllabus.pdf');
    expect(dialog).toHaveTextContent('50.0 MB');
    expect(dialog).toHaveTextContent('uncw.edu');
  });

  it('approves the download', async () => {
    const user = userEvent.setup();
    render(<DownloadPrompt />);
    await Promise.resolve(emit?.(request));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(respondToDownload).toHaveBeenCalledWith('download-1', true);
  });

  it('declines the download', async () => {
    const user = userEvent.setup();
    render(<DownloadPrompt />);
    await Promise.resolve(emit?.(request));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(respondToDownload).toHaveBeenCalledWith('download-1', false);
  });

  it('queues a second request instead of losing it', async () => {
    const user = userEvent.setup();
    render(<DownloadPrompt />);
    await Promise.resolve(emit?.(request));
    await Promise.resolve(emit?.({ ...request, id: 'download-2', filename: 'notes.pdf' }));

    expect(await screen.findByText(/syllabus\.pdf/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The second prompt takes its place rather than vanishing.
    expect(await screen.findByText(/notes\.pdf/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(respondToDownload).toHaveBeenCalledWith('download-2', false);
  });

  it('suspends the native view while the prompt is up and resumes after', async () => {
    const user = userEvent.setup();
    render(<DownloadPrompt />);
    await Promise.resolve(emit?.(request));
    await screen.findByRole('dialog');
    expect(suspend).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(resume).toHaveBeenCalled();
  });
});
