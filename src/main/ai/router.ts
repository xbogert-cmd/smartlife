import { claudeProvider } from './providers/claude';
import type { AIProvider } from './providers/types';

export function getProvider(): AIProvider {
  return claudeProvider;
}
