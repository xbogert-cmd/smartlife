import { app, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CanvasCredentials } from './client';
import { CanvasAuthError, CanvasNetworkError } from './errors';
import { getFile } from './api';
import { setSyncState, SYNC_KEY_TOKEN_INVALID } from './sync';

const MAX_NAME_LENGTH = 120;

/**
 * Canvas display names are attacker-influenced text. Writing one straight into
 * a path would allow directory traversal, so reduce it to a bare filename.
 */
export function safeFileName(name: string): string {
  const lastSegment = basename(name.replace(/\\/g, '/')).trim();
  const cleaned = lastSegment.replace(/^\.+/, '').replace(/[/\0]/g, '');
  if (cleaned.length === 0) return 'download';
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * Download a course file and hand it to the user's default Mac app.
 * The download URL is fetched fresh here because Canvas file URLs expire —
 * it is deliberately never persisted.
 */
export async function openCanvasFile(
  db: Database.Database,
  creds: CanvasCredentials,
  fileId: number
): Promise<void> {
  let file;
  try {
    file = await getFile(creds, fileId);
  } catch (error) {
    if (error instanceof CanvasAuthError) setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
    throw error;
  }

  if (!file.url) throw new CanvasNetworkError('Canvas did not return a download link for this file.');

  let response: Response;
  try {
    response = await fetch(file.url, { headers: { Authorization: `Bearer ${creds.token}` } });
  } catch (error) {
    throw new CanvasNetworkError(error instanceof Error ? error.message : 'Download failed.');
  }
  if (!response.ok) throw new CanvasNetworkError(`Download failed with status ${response.status}.`);

  const cacheDir = join(app.getPath('userData'), 'canvas-files');
  mkdirSync(cacheDir, { recursive: true });
  const name = safeFileName(file.display_name ?? file.filename ?? `file-${fileId}`);
  const target = join(cacheDir, `${fileId}-${name}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));

  const failure = await shell.openPath(target);
  if (failure) throw new Error(`Could not open the file: ${failure}`);
}
