import { useEffect, useRef } from 'react';

/**
 * An empty placeholder whose only job is to tell the main process where the
 * native WebContentsView should sit.
 *
 * The view is not in the React tree -- it is composited above it -- so this
 * div reserves the space and reports its rectangle. ResizeObserver covers size
 * changes (window resize, sidebar collapse); the window resize listener covers
 * the cases where the element moves without changing size. Browser.tsx fills
 * the available height and does not scroll, which is what keeps those two
 * signals sufficient.
 */
export function ViewportSlot(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const report = (): void => {
      const rect = element.getBoundingClientRect();
      void window.smartlife.browser
        .setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => {});
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, []);

  return <div ref={ref} className="min-h-0 flex-1" role="presentation" />;
}
