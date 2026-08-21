import { sanitizeDownloadFilename } from './security';

export interface DownloadRequest {
  filename: string;
  sizeBytes: number;
  sourceUrl: string;
}

/**
 * Structural stand-in for Electron.DownloadItem -- only the members this
 * handler touches, so the whole flow is testable with a plain object.
 */
export interface DownloadItemLike {
  getFilename(): string;
  getTotalBytes(): number;
  getURL(): string;
  setSavePath(path: string): void;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export interface DownloadHandlerOptions {
  downloadsDir: string;
  confirm: (request: DownloadRequest) => Promise<boolean>;
  onError: (error: unknown) => void;
}

/**
 * Wired to session.on('will-download') for the browser partition.
 *
 * Two things must happen synchronously, before the handler returns:
 *
 *   setSavePath -- Electron shows its own save dialog if the path is still
 *   unset when the handler returns, which would bypass our confirmation
 *   entirely.
 *
 *   pause -- otherwise bytes are already being written while the user is still
 *   looking at the prompt.
 *
 * Only then is the user asked. Cancelling discards the partial file.
 */
export function createDownloadHandler(
  options: DownloadHandlerOptions
): (item: DownloadItemLike) => void {
  const { downloadsDir, confirm, onError } = options;

  return (item) => {
    // The server chooses this string; treat it as hostile.
    const filename = sanitizeDownloadFilename(item.getFilename());
    item.setSavePath(`${downloadsDir}/${filename}`);
    item.pause();

    const request: DownloadRequest = {
      // Show the name that will actually be written, not the server's claim.
      filename,
      sizeBytes: item.getTotalBytes(),
      sourceUrl: item.getURL(),
    };

    void confirm(request)
      .then((approved) => {
        if (approved) item.resume();
        else item.cancel();
      })
      .catch((error: unknown) => {
        // A failed prompt must never resolve as "yes".
        onError(error);
        item.cancel();
      });
  };
}
