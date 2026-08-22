import { canvasPost, type CanvasCredentials } from './client';

/**
 * Which of Canvas's three upload steps failed. The distinction is the whole
 * point: a step-2 failure is a dropped upload the user can retry against the
 * still-valid slot, while a step-1 failure means Canvas refused to start.
 * Collapsing them reads to the user as "Canvas rejected your file", which is
 * usually false.
 */
export class CanvasUploadError extends Error {
  readonly step: 1 | 2 | 3;

  constructor(step: 1 | 2 | 3, message: string) {
    super(message);
    this.name = 'CanvasUploadError';
    this.step = step;
  }
}

export interface FileToUpload {
  name: string;
  size: number;
  contentType: string;
  data: Uint8Array;
}

interface UploadSlot {
  upload_url?: string;
  upload_params?: Record<string, string>;
}

/**
 * Canvas's three-step upload.
 *
 *   1. Ask Canvas for a signed slot.                (our API, our token)
 *   2. POST the bytes to the URL Canvas nominated.  (third party, NO token)
 *   3. Follow the redirect back to Canvas.          (our API, our token)
 *
 * Step 2 is signed by Canvas and "will be denied if any parameters from the
 * upload_params response are added, removed or modified" — which is why it
 * cannot go through client.ts, whose requestPage attaches Authorization to
 * every request it makes. The signature is valid for 30 minutes.
 */
export async function uploadSubmissionFile(
  creds: CanvasCredentials,
  courseId: number,
  assignmentId: number,
  file: FileToUpload
): Promise<number> {
  // ---- Step 1: request the slot -----------------------------------------
  let slot: UploadSlot;
  try {
    slot = await canvasPost<UploadSlot>(
      creds,
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
      { name: file.name, size: file.size, content_type: file.contentType }
    );
  } catch (error) {
    throw new CanvasUploadError(1, error instanceof Error ? error.message : String(error));
  }

  const uploadUrl = slot.upload_url;
  const uploadParams = slot.upload_params ?? {};
  if (typeof uploadUrl !== 'string' || uploadUrl.length === 0) {
    throw new CanvasUploadError(1, 'Canvas did not return an upload URL.');
  }

  // ---- Step 2: POST the bytes to the signed URL --------------------------
  const form = new FormData();
  // Every signed param goes in unmodified...
  for (const [key, value] of Object.entries(uploadParams)) {
    form.append(key, value);
  }
  // ...and the file goes in LAST. Canvas's signature validation depends on it.
  form.append('file', new Blob([file.data], { type: file.contentType }), file.name);

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      // Manual: the redirect target is a Canvas API URL that needs our token,
      // and an automatic follow would send it unauthenticated.
      redirect: 'manual',
      // Deliberately no headers. Adding Authorization here breaks the signature.
    });
  } catch (error) {
    throw new CanvasUploadError(2, error instanceof Error ? error.message : String(error));
  }

  const status = uploadResponse.status;

  // A 2xx means Canvas inlined the finished file object; no confirm needed.
  if (status >= 200 && status < 300) {
    const inline = (await uploadResponse.json().catch(() => null)) as { id?: number } | null;
    if (inline && typeof inline.id === 'number') return inline.id;
    throw new CanvasUploadError(3, 'The upload finished but Canvas returned no file id.');
  }

  if (status < 300 || status >= 400) {
    throw new CanvasUploadError(2, `The upload did not finish (HTTP ${status}).`);
  }

  const location = uploadResponse.headers.get('location');
  if (location === null || location.length === 0) {
    throw new CanvasUploadError(2, 'The upload did not finish: Canvas returned no confirmation URL.');
  }

  // ---- Step 3: confirm, this time WITH our token -------------------------
  let confirmResponse: Response;
  try {
    confirmResponse = await fetch(location, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/json' },
    });
  } catch (error) {
    throw new CanvasUploadError(3, error instanceof Error ? error.message : String(error));
  }

  if (!confirmResponse.ok) {
    throw new CanvasUploadError(3, `Canvas did not confirm the upload (HTTP ${confirmResponse.status}).`);
  }

  const confirmed = (await confirmResponse.json().catch(() => null)) as { id?: number } | null;
  if (!confirmed || typeof confirmed.id !== 'number') {
    // Submitting with an unconfirmed id would attach nothing at all.
    throw new CanvasUploadError(3, 'Canvas confirmed the upload without returning a file id.');
  }

  return confirmed.id;
}
