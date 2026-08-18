import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_SECTIONS } from '../nav/sections';
import { useTheme } from '../theme/ThemeProvider';

interface PaletteAction {
  id: string;
  label: string;
  run: () => void;
}

const THEME_ORDER = ['light', 'dark', 'system'] as const;

export function CommandPalette({ onClose, onOpenAI }: { onClose: () => void; onOpenAI: () => void }) {
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();
  const [query, setQuery] = useState('');

  const actions: PaletteAction[] = useMemo(() => {
    const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length];
    const sectionActions = NAV_SECTIONS.map((section) => ({
      id: `nav-${section.slug}`,
      label: `Go to ${section.label}`,
      run: () => navigate(section.path),
    }));
    return [
      { id: 'ask-ai', label: 'Ask AI', run: onOpenAI },
      { id: 'toggle-theme', label: `Switch theme to ${nextTheme}`, run: () => setPreference(nextTheme) },
      ...sectionActions,
    ];
  }, [navigate, onOpenAI, preference, setPreference]);

  const filtered = actions.filter((action) => action.label.toLowerCase().includes(query.toLowerCase()));

  function runAndClose(action: PaletteAction): void {
    action.run();
    onClose();
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 120,
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 480,
          maxHeight: 360,
          backgroundColor: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a command…"
          className="px-4 py-3 text-sm"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--color-text)',
            border: 'none',
            borderBottom: '1px solid var(--color-border)',
            outline: 'none',
          }}
        />
        <div style={{ overflow: 'auto' }}>
          {filtered.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => runAndClose(action)}
              className="w-full px-4 py-2 text-left text-sm"
              style={{ backgroundColor: 'transparent', color: 'var(--color-text)', border: 'none' }}
            >
              {action.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No matching commands.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
