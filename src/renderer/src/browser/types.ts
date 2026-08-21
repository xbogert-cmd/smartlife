export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: number; description: string } | null;
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string;
}

export interface BrowserDownloadRequest {
  id: string;
  filename: string;
  sizeBytes: number;
  sourceUrl: string;
}

export interface BrowserFindResult {
  activeMatchOrdinal: number;
  matches: number;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  visitedAt: string;
}

/** The browser section's own accent, copied from nav/sectionThemes.ts. */
export const BROWSER_ACCENT = '#2DD4BF';
