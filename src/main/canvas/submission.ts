/**
 * Pure classification of a Canvas assignment's submission_types into the one
 * path the app will handle it by. No electron import, no I/O — every branch
 * here is a decision the UI, the IPC layer and the AI tool all read from.
 */

export type SubmissionPath =
  | { kind: 'text' }
  | { kind: 'file' }
  | { kind: 'text-or-file' }
  | { kind: 'discussion'; topicId: number }
  | { kind: 'handoff'; reason: 'external_tool' | 'quiz' | 'unresolved_discussion' }
  | { kind: 'none' };

/** canvas_assignments.submission_types stores Canvas's array verbatim as JSON. */
export function parseSubmissionTypes(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * `topicId` comes from canvas_discussion_topics, matched by assignment_id.
 * It is null when the topic has not synced yet, which downgrades a discussion
 * to a handoff rather than to "nothing to submit".
 */
export function classifySubmission(raw: string | null, topicId: number | null): SubmissionPath {
  const types = parseSubmissionTypes(raw);

  // Handoff wins over everything: an assignment offering both an external tool
  // and a text entry is one where the tool is the real work.
  if (types.includes('external_tool')) return { kind: 'handoff', reason: 'external_tool' };
  if (types.includes('online_quiz')) return { kind: 'handoff', reason: 'quiz' };

  if (types.includes('discussion_topic')) {
    if (topicId === null) return { kind: 'handoff', reason: 'unresolved_discussion' };
    return { kind: 'discussion', topicId };
  }

  const hasText = types.includes('online_text_entry');
  const hasFile = types.includes('online_upload');
  if (hasText && hasFile) return { kind: 'text-or-file' };
  if (hasText) return { kind: 'text' };
  if (hasFile) return { kind: 'file' };

  return { kind: 'none' };
}
