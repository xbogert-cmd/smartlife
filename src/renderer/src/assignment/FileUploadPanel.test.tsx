import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileUploadPanel } from './FileUploadPanel';

const pickFile = vi.fn();

beforeEach(() => {
  pickFile.mockReset();
  (window as unknown as { smartlife: unknown }).smartlife = { canvas: { pickFile } };
});

describe('FileUploadPanel', () => {
  it('shows nothing chosen initially', () => {
    render(<FileUploadPanel onSubmit={() => {}} />);
    expect(screen.getByText(/no file chosen/i)).toBeTruthy();
  });

  it('cannot submit before a file is chosen', () => {
    render(<FileUploadPanel onSubmit={() => {}} />);
    expect((screen.getByRole('button', { name: /submit/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the chosen filename and size', async () => {
    pickFile.mockResolvedValue({ path: '/Users/a/essay.pdf', name: 'essay.pdf', size: 2048 });
    render(<FileUploadPanel onSubmit={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /choose file/i }));

    expect(await screen.findByText(/essay\.pdf/)).toBeTruthy();
    expect(screen.getByText(/2,048/)).toBeTruthy();
  });

  it('keeps the previous choice when the picker is cancelled', async () => {
    pickFile.mockResolvedValueOnce({ path: '/a/one.pdf', name: 'one.pdf', size: 10 });
    render(<FileUploadPanel onSubmit={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /choose file/i }));
    await screen.findByText(/one\.pdf/);

    pickFile.mockResolvedValueOnce(null);
    await userEvent.click(screen.getByRole('button', { name: /choose a different file/i }));

    expect(screen.getByText(/one\.pdf/)).toBeTruthy();
  });

  it('hands the chosen file up on submit', async () => {
    const onSubmit = vi.fn();
    pickFile.mockResolvedValue({ path: '/Users/a/essay.pdf', name: 'essay.pdf', size: 2048 });
    render(<FileUploadPanel onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: /choose file/i }));
    await screen.findByText(/essay\.pdf/);
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith({ path: '/Users/a/essay.pdf', name: 'essay.pdf', size: 2048 });
  });

  it('disables submission while a submit is in flight', async () => {
    pickFile.mockResolvedValue({ path: '/a/x.pdf', name: 'x.pdf', size: 1 });
    const { rerender } = render(<FileUploadPanel onSubmit={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /choose file/i }));
    await screen.findByText(/x\.pdf/);

    rerender(<FileUploadPanel disabled onSubmit={() => {}} />);
    expect((screen.getByRole('button', { name: /submit/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
