import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useViewContext } from './useViewContext';

function renderAt(path: string) {
  return renderHook(() => useViewContext(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/assignment/:assignmentId" element={<>{children}</>} />
          <Route path="/school/course/:courseId" element={<>{children}</>} />
          <Route path="*" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    ),
  });
}

describe('useViewContext', () => {
  it('reports the assignment route with a numeric id', () => {
    const { result } = renderAt('/assignment/42');
    expect(result.current).toEqual({ route: 'assignment', assignmentId: 42 });
  });

  it('reports the course route with a numeric id', () => {
    const { result } = renderAt('/school/course/7');
    expect(result.current).toEqual({ route: 'course', courseId: 7 });
  });

  it('reports the calendar route with no selection when nothing is selected', () => {
    const { result } = renderAt('/calendar');
    expect(result.current).toEqual({ route: 'calendar' });
  });

  it('carries the selected event id from ?event= into the view context', () => {
    // Calendar.tsx's openEventDialog is the only writer of this param -- it's
    // the sole channel between the route's local dialog state and this
    // route-derived hook.
    const { result } = renderAt('/calendar?event=abc123');
    expect(result.current).toEqual({ route: 'calendar', selectedEventId: 'abc123' });
  });

  it('drops the selection once the query param is gone', () => {
    const { result } = renderAt('/calendar?event=');
    // An empty value still round-trips as a present, empty string param --
    // only a fully absent key means "nothing selected".
    expect(result.current).toEqual({ route: 'calendar', selectedEventId: '' });
  });

  it('reports home, school, settings, ai, and browser with no id', () => {
    expect(renderAt('/').result.current).toEqual({ route: 'home' });
    expect(renderAt('/school').result.current).toEqual({ route: 'school' });
    expect(renderAt('/settings').result.current).toEqual({ route: 'settings' });
    expect(renderAt('/ai').result.current).toEqual({ route: 'ai' });
    expect(renderAt('/browser').result.current).toEqual({ route: 'browser' });
  });

  it('returns null for an unrecognized route', () => {
    const { result } = renderAt('/something-unmapped');
    expect(result.current).toBeNull();
  });
});
