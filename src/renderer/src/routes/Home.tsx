export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Home() {
  const text = greeting(new Date().getHours());
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
        {text}
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Nothing wired up yet — start with Settings.</p>
    </div>
  );
}
