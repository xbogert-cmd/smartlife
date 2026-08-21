export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts the rectangle the renderer measured with getBoundingClientRect into
 * the rectangle WebContentsView.setBounds wants.
 *
 * Deliberately does NOT apply devicePixelRatio: setBounds takes
 * device-independent pixels, the same unit getBoundingClientRect reports.
 * Scaling by DPR would double the view's size on a Retina display.
 *
 * Electron rejects fractional and negative bounds, and a ResizeObserver on a
 * flex child reports both -- fractional widths routinely, and negative
 * dimensions momentarily while the sidebar animates.
 */
export function toViewBounds(rect: ViewportRect): ViewportRect {
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}
