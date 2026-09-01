import { NavLink } from 'react-router-dom';
import {
  Home as HomeIcon,
  Sparkles,
  Calendar,
  GraduationCap,
  Globe,
  CheckSquare,
  FileText,
  Target,
  Folder,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { NAV_SECTIONS } from './sections';
import { getSectionTheme } from './sectionThemes';

interface SidebarProps {
  aiOpen: boolean;
  onToggleAi: () => void;
  hasPendingConfirmation: boolean;
}

const ICONS: Record<string, LucideIcon> = {
  home: HomeIcon,
  ai: Sparkles,
  calendar: Calendar,
  school: GraduationCap,
  browser: Globe,
  tasks: CheckSquare,
  notes: FileText,
  goals: Target,
  files: Folder,
  search: Search,
  settings: SettingsIcon,
};

export function Sidebar({ aiOpen, onToggleAi, hasPendingConfirmation }: SidebarProps) {
  return (
    <nav
      className="flex w-56 flex-shrink-0 flex-col gap-1 border-r p-3"
      // Clears the traffic-light buttons -- src/main/index.ts sets
      // trafficLightPosition: { x: 20, y: 20 } explicitly, so this number is
      // a deliberate match to that, not a guess at the OS default.
      style={{
        borderColor: 'var(--color-border)',
        backgroundColor: 'var(--color-sidebar-bg)',
        paddingTop: 44,
      }}
    >
      {NAV_SECTIONS.map((section) => {
        const theme = getSectionTheme(section.slug);
        const Icon = ICONS[section.slug] ?? HomeIcon;
        return (
          <NavLink
            key={section.slug}
            to={section.path}
            end={section.path === '/'}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
            style={({ isActive }) => ({
              backgroundColor: isActive ? `color-mix(in srgb, ${theme.accent} 16%, transparent)` : 'transparent',
              color: isActive ? `color-mix(in srgb, ${theme.accent} 50%, var(--color-text))` : 'var(--color-text-muted)',
            })}
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={16}
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    color: isActive ? theme.accent : `color-mix(in srgb, ${theme.accent} 50%, transparent)`,
                  }}
                />
                {section.label}
              </>
            )}
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
            style={{ backgroundColor: 'var(--color-danger)' }}
          />
        )}
      </button>
    </nav>
  );
}
