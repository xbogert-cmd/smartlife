import { describe, expect, it } from 'vitest';
import { textForSpeech } from './textForSpeech';

describe('textForSpeech', () => {
  it('strips bold and italic markers', () => {
    expect(textForSpeech('This is **bold** and this is *italic*.')).toBe('This is bold and this is italic.');
  });

  it('strips heading markers', () => {
    expect(textForSpeech('# Big Heading\n## Smaller heading\ntext')).toBe('Big Heading\nSmaller heading\ntext');
  });

  it('strips bullet list markers, keeping the item text', () => {
    expect(textForSpeech('- first item\n- second item\n* third item')).toBe('first item\nsecond item\nthird item');
  });

  it('strips inline code backticks and code fences', () => {
    expect(textForSpeech('Run `npm test` to check.\n```\ncode block\n```')).toBe('Run npm test to check.\ncode block');
  });

  it('collapses extra whitespace left behind by stripping', () => {
    expect(textForSpeech('**  spaced  **')).toBe('spaced');
  });

  it('leaves plain prose completely unchanged', () => {
    expect(textForSpeech('Just a normal sentence with no markdown at all.')).toBe(
      'Just a normal sentence with no markdown at all.'
    );
  });
});
