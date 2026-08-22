import { useLocation, useParams } from 'react-router-dom';

/**
 * Mirrors main's ViewContext. Only a route name and, at most, an id crosses
 * the bridge — every human-readable value is resolved main-side, so nothing
 * here can shape what the model reads as context.
 */
export type ViewContextValue =
  | { route: 'home' | 'settings' | 'school' | 'ai' | 'browser' }
  | { route: 'course'; courseId: number }
  | { route: 'assignment'; assignmentId: number }
  | { route: 'calendar'; selectedEventId?: string };

export function useViewContext(): ViewContextValue | null {
  const { pathname } = useLocation();
  const params = useParams();

  if (pathname.startsWith('/assignment/')) {
    const id = Number(params.assignmentId ?? pathname.split('/')[2]);
    return Number.isFinite(id) ? { route: 'assignment', assignmentId: id } : null;
  }
  if (pathname.startsWith('/school/course/')) {
    const id = Number(params.courseId ?? pathname.split('/')[3]);
    return Number.isFinite(id) ? { route: 'course', courseId: id } : null;
  }
  if (pathname.startsWith('/browser')) return { route: 'browser' };
  if (pathname.startsWith('/calendar')) return { route: 'calendar' };
  if (pathname.startsWith('/school')) return { route: 'school' };
  if (pathname.startsWith('/settings')) return { route: 'settings' };
  if (pathname.startsWith('/ai')) return { route: 'ai' };
  if (pathname === '/') return { route: 'home' };
  return null;
}
