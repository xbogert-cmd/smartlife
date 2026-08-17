export interface NavSection {
  slug: string;
  label: string;
  path: string;
}

export const NAV_SECTIONS: NavSection[] = [
  { slug: 'home', label: 'Home', path: '/' },
  { slug: 'ai', label: 'AI', path: '/ai' },
  { slug: 'calendar', label: 'Calendar', path: '/calendar' },
  { slug: 'school', label: 'School', path: '/school' },
  { slug: 'browser', label: 'Browser', path: '/browser' },
  { slug: 'tasks', label: 'Tasks', path: '/tasks' },
  { slug: 'notes', label: 'Notes', path: '/notes' },
  { slug: 'goals', label: 'Goals', path: '/goals' },
  { slug: 'files', label: 'Files', path: '/files' },
  { slug: 'search', label: 'Search', path: '/search' },
  { slug: 'settings', label: 'Settings', path: '/settings' },
];
