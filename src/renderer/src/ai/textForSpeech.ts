/**
 * Strips markdown syntax before handing text to speechSynthesis -- reading
 * "**bold**" or "- item" aloud verbatim (asterisks, dashes, hashes, backticks)
 * sounds broken. Only affects what gets spoken; the visible chat bubble text
 * is untouched (this function's output is never rendered).
 */
export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
