export interface SectionTheme {
  gradient: string;
  accent: string;
}

const REGISTRY: Record<string, SectionTheme> = {
  home: { gradient: 'linear-gradient(135deg, #6D5EFC, #8F7BFF)', accent: '#6D5EFC' },
  ai: { gradient: 'linear-gradient(135deg, #0E7490, #22D3EE)', accent: '#22D3EE' },
  calendar: { gradient: 'linear-gradient(135deg, #9A3412, #FB923C)', accent: '#FB923C' },
  school: { gradient: 'linear-gradient(135deg, #1E3A8A, #3B82F6)', accent: '#3B82F6' },
  browser: { gradient: 'linear-gradient(135deg, #0F766E, #2DD4BF)', accent: '#2DD4BF' },
  tasks: { gradient: 'linear-gradient(135deg, #166534, #4ADE80)', accent: '#4ADE80' },
  notes: { gradient: 'linear-gradient(135deg, #92400E, #FBBF24)', accent: '#FBBF24' },
  goals: { gradient: 'linear-gradient(135deg, #9D174D, #F472B6)', accent: '#F472B6' },
  files: { gradient: 'linear-gradient(135deg, #334155, #94A3B8)', accent: '#94A3B8' },
  search: { gradient: 'linear-gradient(135deg, #6D5EFC, #8F7BFF)', accent: '#6D5EFC' },
  settings: { gradient: 'linear-gradient(135deg, #27272A, #71717A)', accent: '#71717A' },
};

const DEFAULT_THEME: SectionTheme = REGISTRY.home;

export function getSectionTheme(slug: string): SectionTheme {
  return REGISTRY[slug] ?? DEFAULT_THEME;
}
