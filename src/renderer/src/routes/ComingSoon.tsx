export function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
        {label}
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Coming in a later phase.</p>
    </div>
  );
}
