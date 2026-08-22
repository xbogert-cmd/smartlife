import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getAssignmentDetail } from '../../canvas/queries';
import { getCanvasCredentials } from '../../canvas/token';
import { getActiveCanvasScheduler } from '../../canvas/schedulerRegistry';
import { submitAssignment } from '../../canvas/submit';

export const canvasSubmitAssignmentTool: ToolDefinition = {
  name: 'canvas_submit_assignment',
  // The one tier auto mode does not skip. Submitting reaches the user's
  // university and cannot be taken back.
  tier: 'ALWAYS_CONFIRM',
  label: 'Submit an assignment',
  schema: {
    name: 'canvas_submit_assignment',
    description:
      "Submit a text answer to a Canvas assignment, or post to a graded discussion. Only works for assignments that accept a text entry or are discussions. File uploads cannot be submitted this way — tell the user to attach the file in the assignment view and submit there. Always show the user the exact text first; they will be asked to confirm.",
    input_schema: {
      type: 'object',
      properties: {
        assignmentId: {
          type: 'number',
          description: 'The Canvas assignment id, from canvas_upcoming_assignments.',
        },
        text: {
          type: 'string',
          description: 'The exact text to submit. For a discussion, the body of the post.',
        },
      },
      required: ['assignmentId', 'text'],
    },
  },
  async run(input, ctx) {
    const assignmentId = Number(input.assignmentId);
    const text = String(input.text ?? '');

    if (!Number.isFinite(assignmentId)) return 'assignmentId must be a number.';
    if (text.trim().length === 0) return 'There is nothing to submit — the text is empty.';

    const detail = getAssignmentDetail(ctx.db, assignmentId);
    if (detail === null) return `Assignment ${assignmentId} is not in the local database.`;

    const path = detail.path;

    // Refuse before asking, so the user is never shown a confirmation for
    // something that cannot happen.
    if (path.kind === 'handoff') {
      return `"${detail.name}" has to be completed in the browser — Canvas has no API for submitting it.`;
    }
    if (path.kind === 'none') {
      return `"${detail.name}" does not take a submission.`;
    }
    if (path.kind === 'file') {
      return `"${detail.name}" takes a file upload. Open it in the assignment view, attach the file there, and submit — I can't attach files.`;
    }

    const isDiscussion = path.kind === 'discussion';
    // The user is approving specific bytes, so the description carries them in
    // full. Never summarise or truncate this.
    const warning = isDiscussion
      ? ' This is a discussion post: it will be visible to your whole class, and students usually cannot delete their own posts.'
      : '';
    const description = `Submit to "${detail.name}" (${detail.courseName}).${warning}\n\n--- exactly what will be submitted ---\n${text}`;

    const approved = await gate(
      'ALWAYS_CONFIRM',
      ctx.mode,
      'canvas_submit_assignment',
      description,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so nothing was submitted.';

    const creds = getCanvasCredentials(ctx.db);
    if (creds === null) return 'Canvas is not connected.';

    const scheduler = getActiveCanvasScheduler();
    const send = (): ReturnType<typeof submitAssignment> =>
      Promise.resolve(
        submitAssignment(
          ctx.db,
          creds,
          assignmentId,
          isDiscussion ? { kind: 'discussion', message: text } : { kind: 'text', body: text }
        )
      );

    // Same exclusivity guard the UI path uses; without a scheduler there is no
    // background sync to collide with.
    const outcome = scheduler === null ? await send() : await scheduler.runExclusive(send);
    if (outcome === null) return 'A Canvas sync is already in progress. Try again shortly.';

    return outcome.message;
  },
};
