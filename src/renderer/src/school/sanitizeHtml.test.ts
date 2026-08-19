import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitizeHtml';

describe('sanitizeHtml', () => {
  it('keeps ordinary formatting', () => {
    expect(sanitizeHtml('<p>Read <strong>chapter 4</strong></p>')).toBe(
      '<p>Read <strong>chapter 4</strong></p>'
    );
  });

  it('removes script elements entirely', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('removes iframes, objects, embeds, and forms', () => {
    const dirty = '<iframe src="x"></iframe><object></object><embed><form></form><p>ok</p>';
    expect(sanitizeHtml(dirty)).toBe('<p>ok</p>');
  });

  it('strips inline event handlers', () => {
    const result = sanitizeHtml('<img src="https://uncw.instructure.com/a.png" onerror="alert(1)">');
    expect(result).not.toContain('onerror');
    expect(result).toContain('src="https://uncw.instructure.com/a.png"');
  });

  it('strips javascript: URLs from links', () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
    expect(result).toContain('click');
  });

  it('strips javascript: URLs obfuscated with an embedded tab or newline, which browsers ignore when resolving the scheme', () => {
    const tabbed = sanitizeHtml('<a href="java\tscript:alert(1)">click</a>');
    expect(tabbed).not.toMatch(/href/);
    const newlined = sanitizeHtml('<a href="java\nscript:alert(1)">click</a>');
    expect(newlined).not.toMatch(/href/);
  });

  it('keeps Canvas image sources so the CSP allowance is useful', () => {
    const result = sanitizeHtml('<img src="https://uncw.instructure.com/files/1/preview">');
    expect(result).toContain('https://uncw.instructure.com/files/1/preview');
  });

  it('returns an empty string for empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it('strips style and meta/link/base elements', () => {
    const dirty = '<style>body{}</style><link rel="stylesheet" href="x"><meta http-equiv="refresh"><base href="//evil.example/"><p>ok</p>';
    expect(sanitizeHtml(dirty)).toBe('<p>ok</p>');
  });

  it('strips javascript: URLs regardless of case and surrounding whitespace', () => {
    const result = sanitizeHtml('<a href="  JaVaScRiPt:alert(1)">click</a>');
    expect(result.toLowerCase()).not.toContain('javascript:');
  });

  it('strips javascript: URLs from SVG xlink:href attributes', () => {
    const dirty = '<svg><a xlink:href="javascript:alert(1)"><text>click</text></a></svg>';
    const result = sanitizeHtml(dirty);
    expect(result).not.toContain('javascript:');
  });

  it('strips the srcdoc attribute, which can embed an inline HTML document with scripts', () => {
    const result = sanitizeHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe><p>ok</p>');
    expect(result).not.toContain('srcdoc');
    expect(result).not.toContain('<script>');
  });

  it('neutralizes an SVG animate-based handler vector (onbegin/onload without a plain on* prefix bypass)', () => {
    const result = sanitizeHtml('<svg><animate onbegin="alert(1)" attributeName="x" /></svg>');
    expect(result).not.toContain('onbegin');
  });

  it('strips event handlers regardless of attribute case', () => {
    const result = sanitizeHtml('<img src="x.png" ONERROR="alert(1)">');
    expect(result.toLowerCase()).not.toContain('onerror');
  });

  it('strips javascript: URLs even when HTML-entity-encoded, since the parser decodes attributes first', () => {
    const result = sanitizeHtml('<a href="j&#97;vascript:alert(1)">click</a>');
    expect(result.toLowerCase()).not.toContain('javascript:');
  });

  // ponytail: data: URLs on href are NOT stripped — out of the brief's scope
  // (script/iframe/object/embed/form removal, on* handlers, javascript:
  // URLs) and lower severity since navigation requires a user click rather
  // than firing automatically, plus <img src="data:image/...">  is a
  // legitimate way to embed inline images. Revisit if Canvas content is ever
  // rendered somewhere a click-through data: URL matters more (e.g. an
  // in-app webview that fully renders the target).
  it('documents that data: URLs on href are a known, intentionally uncovered vector', () => {
    const result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>');
    expect(result).toContain('data:text/html');
  });
});
