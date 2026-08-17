import { NavLink } from 'react-router-dom';
import { NAV_SECTIONS } from './sections';
import { getSectionTheme } from './sectionThemes';

export function Sidebar() {
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
    </nav>
  );
}
