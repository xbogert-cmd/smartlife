import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemIsDark ? 'dark' : 'light';
  return preference;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [systemIsDark, setSystemIsDark] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.smartlife.theme.get().then((value) => {
      setPreferenceState(value);
      setLoaded(true);
    });
    setSystemIsDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    return window.smartlife.theme.onSystemChange((isDark) => setSystemIsDark(isDark));
  }, []);

  const resolved = resolveTheme(preference, systemIsDark);

  useEffect(() => {
    if (loaded) {
      document.documentElement.setAttribute('data-theme', resolved);
    }
  }, [resolved, loaded]);

  function setPreference(value: ThemePreference): void {
    setPreferenceState(value);
    window.smartlife.theme.set(value);
  }

  if (!loaded) return null;

  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
