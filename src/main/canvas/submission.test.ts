import { describe, expect, it } from 'vitest';
import { classifySubmission, parseSubmissionTypes } from './submission';

describe('parseSubmissionTypes', () => {
  it('parses the JSON array Canvas stores', () => {
    expect(parseSubmissionTypes('["online_upload"]')).toEqual(['online_upload']);
  });

  it('parses a multi-type array', () => {
    expect(parseSubmissionTypes('["online_text_entry","online_upload"]')).toEqual([
      'online_text_entry',
      'online_upload',
    ]);
  });

  it('returns empty for null', () => {
    expect(parseSubmissionTypes(null)).toEqual([]);
  });

  it('returns empty for malformed JSON rather than throwing', () => {
    expect(parseSubmissionTypes('["unterminated')).toEqual([]);
  });

  it('returns empty when the JSON is valid but not an array', () => {
    expect(parseSubmissionTypes('{"a":1}')).toEqual([]);
  });

  it('drops non-string members', () => {
    expect(parseSubmissionTypes('["online_upload",3,null]')).toEqual(['online_upload']);
  });
});

describe('classifySubmission', () => {
  it('classifies text entry', () => {
    expect(classifySubmission('["online_text_entry"]', null)).toEqual({ kind: 'text' });
  });

  it('classifies file upload', () => {
    expect(classifySubmission('["online_upload"]', null)).toEqual({ kind: 'file' });
  });

  it('classifies text-or-file when both are offered', () => {
    expect(classifySubmission('["online_text_entry","online_upload"]', null)).toEqual({
      kind: 'text-or-file',
    });
  });

  it('classifies external tool as a handoff', () => {
    expect(classifySubmission('["external_tool"]', null)).toEqual({
      kind: 'handoff',
      reason: 'external_tool',
    });
  });

  it('classifies a quiz as a handoff', () => {
    expect(classifySubmission('["online_quiz"]', null)).toEqual({ kind: 'handoff', reason: 'quiz' });
  });

  it('classifies none', () => {
    expect(classifySubmission('["none"]', null)).toEqual({ kind: 'none' });
  });

  it('classifies an unknown type as none rather than guessing', () => {
    expect(classifySubmission('["media_recording"]', null)).toEqual({ kind: 'none' });
  });

  it('classifies discussion when the topic resolved', () => {
    expect(classifySubmission('["discussion_topic"]', 55)).toEqual({
      kind: 'discussion',
      topicId: 55,
    });
  });

  it('degrades an unresolved discussion to a handoff, not to none', () => {
    // A discussion we cannot address is still work the user has to do; sending
    // them to the browser is right, telling them there is nothing to submit is not.
    expect(classifySubmission('["discussion_topic"]', null)).toEqual({
      kind: 'handoff',
      reason: 'unresolved_discussion',
    });
  });

  it('lets external_tool win over a text entry offered alongside it', () => {
    // An assignment offering both is one where the tool is the real work.
    expect(classifySubmission('["external_tool","online_text_entry"]', null)).toEqual({
      kind: 'handoff',
      reason: 'external_tool',
    });
  });

  it('lets external_tool win over a resolved discussion', () => {
    expect(classifySubmission('["external_tool","discussion_topic"]', 55)).toEqual({
      kind: 'handoff',
      reason: 'external_tool',
    });
  });

  it('lets a quiz win over a text entry', () => {
    expect(classifySubmission('["online_quiz","online_text_entry"]', null)).toEqual({
      kind: 'handoff',
      reason: 'quiz',
    });
  });

  it('treats a null submission_types column as none', () => {
    expect(classifySubmission(null, null)).toEqual({ kind: 'none' });
  });
});
