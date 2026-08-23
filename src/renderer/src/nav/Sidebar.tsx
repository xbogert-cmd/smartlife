import { NavLink } from 'react-router-dom';
import { NAV_SECTIONS } from './sections';
import { getSectionTheme } from './sectionThemes';

interface SidebarProps {
  aiOpen: boolean;
  onToggleAi: () => void;
  hasPendingConfirmation: boolean;
}

export function Sidebar({ aiOpen, onToggleAi, hasPendingConfirmation }: SidebarProps) {
  return (
    <nav className="flex w-56 flex-shrink-0 flex-col gap-1 border-r p-3" style={{ borderColor: 'var(--color-border)' }}>
      {NAV_SECTIONS.map((section) => {
        const theme = getSectionTheme(section.slug);
        return (
          <NavLink
            key={section.slug}
            to={section.path}
            end={section.path === '/'}
            className={({ isActive }) =>
              `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'text-white' : 'hover:opacity-80'
              }`
            }
            style={({ isActive }) => ({
              backgroundColor: isActive ? theme.accent : 'transparent',
              color: isActive ? '#ffffff' : 'var(--color-text-muted)',
            })}
          >
            {section.label}
          </NavLink>
        );
      })}

      {/*
        The assistant toggle lives here rather than floating over the content
        area: the embedded browser is a native view composited above the React
        tree, so a button drawn over its rectangle would be invisible on
        /browser -- the one route where it is most needed. The sidebar is
        chrome the native view never covers.
      */}
      <button
        type="button"
        onClick={onToggleAi}
        aria-pressed={aiOpen}
        className="relative mt-auto rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors hover:opacity-80"
        style={{
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-muted)',
          backgroundColor: aiOpen ? 'var(--color-surface)' : 'transparent',
        }}
      >
        {aiOpen ? 'Hide assistant' : 'Ask AI'}
        <span className="ml-2 opacity-60">⌘J</span>
        {hasPendingConfirmation && !aiOpen && (
          <span
            data-testid="pending-confirmation-badge"
            aria-label="Waiting for your approval"
            className="absolute right-2 top-2 h-2 w-2 rounded-full"
            style={{ backgroundColor: '#EF4444' }}
          />
        )}
      </button>
    </nav>
  );
}
