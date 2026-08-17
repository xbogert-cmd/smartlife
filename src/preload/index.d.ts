export {};

declare global {
  interface Window {
    smartlife: Record<string, never>;
  }
}
