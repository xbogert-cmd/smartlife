import { useEffect, useState } from 'react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { Sidebar } from './nav/Sidebar';
import { NAV_SECTIONS } from './nav/sections';
import { Home } from './routes/Home';
import { Settings } from './routes/Settings';
import { AI } from './routes/AI';
import { School } from './routes/School';
import { Course } from './routes/Course';
import { Calendar } from './routes/Calendar';
import { Browser } from './routes/Browser';
import { ComingSoon } from './routes/ComingSoon';
import { AIOverlay } from './ai/AIOverlay';
import { CommandPalette } from './command-palette/CommandPalette';

function NavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => window.smartlife.navigation.onNavigate((path) => navigate(path)), [navigate]);
  return null;
}

function Shell() {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.metaKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOverlayOpen((open) => !open);
      } else if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setOverlayOpen(false);
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <NavigationBridge />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/ai" element={<AI />} />
          <Route path="/school" element={<School />} />
          <Route path="/school/course/:courseId" element={<Course />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/browser" element={<Browser />} />
          {NAV_SECTIONS.filter(
            (section) =>
              section.path !== '/' &&
              section.path !== '/settings' &&
              section.path !== '/ai' &&
              section.path !== '/school' &&
              section.path !== '/calendar' &&
              section.path !== '/browser'
          ).map((section) => (
            <Route key={section.slug} path={section.path} element={<ComingSoon label={section.label} />} />
          ))}
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      {overlayOpen && <AIOverlay onClose={() => setOverlayOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenAI={() => {
            setPaletteOpen(false);
            setOverlayOpen(true);
          }}
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <MemoryRouter>
        <Shell />
      </MemoryRouter>
    </ThemeProvider>
  );
}
