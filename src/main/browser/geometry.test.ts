import { describe, expect, it } from 'vitest';
import { toViewBounds } from './geometry';

describe('toViewBounds', () => {
  it('rounds fractional values to integers', () => {
    expect(toViewBounds({ x: 12.4, y: 88.6, width: 640.5, height: 480.2 })).toEqual({
      x: 12,
      y: 89,
      width: 641,
      height: 480,
    });
  });

  it('passes integers through unchanged', () => {
    expect(toViewBounds({ x: 0, y: 100, width: 800, height: 600 })).toEqual({
      x: 0,
      y: 100,
      width: 800,
      height: 600,
    });
  });

  it('clamps negative offsets to zero', () => {
    expect(toViewBounds({ x: -5, y: -12, width: 400, height: 300 })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it('clamps negative dimensions to zero rather than passing them to Electron', () => {
    expect(toViewBounds({ x: 10, y: 10, width: -1, height: -50 })).toEqual({
      x: 10,
      y: 10,
      width: 0,
      height: 0,
    });
  });

  it('handles a collapsed rectangle', () => {
    expect(toViewBounds({ x: 0, y: 0, width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
