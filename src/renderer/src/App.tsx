import { useEffect } from 'react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { Sidebar } from './nav/Sidebar';
import { NAV_SECTIONS } from './nav/sections';
import { Home } from './routes/Home';
import { Settings } from './routes/Settings';
import { ComingSoon } from './routes/ComingSoon';

function NavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => window.smartlife.navigation.onNavigate((path) => navigate(path)), [navigate]);
  return null;
}

function Shell() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <NavigationBridge />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          {NAV_SECTIONS.filter((section) => section.path !== '/' && section.path !== '/settings').map((section) => (
            <Route key={section.slug} path={section.path} element={<ComingSoon label={section.label} />} />
          ))}
        </Routes>
      </main>
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
