/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildExtractionScript,
  fencePageText,
  MAX_EXTRACT_CHARS,
  shapeExtraction,
  type RawExtraction,
} from './extract';

/** Evaluates the real generated script against the jsdom document. */
function runScript(maxChars: number): RawExtraction {
  // eslint-disable-next-line no-eval
  return eval(buildExtractionScript(maxChars)) as RawExtraction;
}

describe('buildExtractionScript', () => {
  beforeEach(() => {
    document.title = '';
    document.body.innerHTML = '';
  });

  it('extracts visible body text', () => {
    document.title = 'Registrar';
    document.body.innerHTML = '<p>Registration opens Monday.</p><p>Bring your ID.</p>';
    const result = runScript(MAX_EXTRACT_CHARS);
    expect(result.title).toBe('Registrar');
    expect(result.text).toContain('Registration opens Monday.');
    expect(result.text).toContain('Bring your ID.');
    expect(result.hasBody).toBe(true);
  });

  it('prefers <main> over the rest of the body', () => {
    document.body.innerHTML =
      '<header>Site header junk</header><main><p>The actual article.</p></main><footer>Footer junk</footer>';
    const result = runScript(MAX_EXTRACT_CHARS);
    expect(result.text).toContain('The actual article.');
    expect(result.text).not.toContain('Site header junk');
    expect(result.text).not.toContain('Footer junk');
  });

  it('strips script, style, nav, footer, aside and noscript content', () => {
    document.body.innerHTML = `
      <p>Keep this.</p>
      <script>var secret = "drop this";</script>
      <style>.x { color: red; }</style>
      <nav>Navigation links</nav>
      <footer>Footer text</footer>
      <aside>Sidebar text</aside>
      <noscript>Enable JavaScript</noscript>
    `;
    const result = runScript(MAX_EXTRACT_CHARS);
    expect(result.text).toContain('Keep this.');
    for (const dropped of [
      'drop this',
      'color: red',
      'Navigation links',
      'Footer text',
      'Sidebar text',
      'Enable JavaScript',
    ]) {
      expect(result.text).not.toContain(dropped);
    }
  });

  it('collapses whitespace inside a text node', () => {
    document.body.innerHTML = '<p>lots     of\n\n   space</p>';
    expect(runScript(MAX_EXTRACT_CHARS).text).toContain('lots of space');
  });

  it('truncates at maxChars and reports it', () => {
    document.body.innerHTML = `<p>${'x'.repeat(500)}</p>`;
    const result = runScript(100);
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation when the page fits', () => {
    document.body.innerHTML = '<p>short</p>';
    expect(runScript(MAX_EXTRACT_CHARS).truncated).toBe(false);
  });
});

describe('shapeExtraction', () => {
  const base: RawExtraction = {
    title: 'Registrar',
    text: 'Registration opens Monday.',
    truncated: false,
    isPdf: false,
    hasBody: true,
  };

  it('returns ok for a normal page', () => {
    const result = shapeExtraction(base, 'https://uncw.edu/registrar');
    expect(result.status).toBe('ok');
    expect(result.url).toBe('https://uncw.edu/registrar');
    expect(result.text).toBe('Registration opens Monday.');
  });

  it('reports pdf rather than returning the viewer chrome as text', () => {
    const result = shapeExtraction({ ...base, isPdf: true, text: '' }, 'https://uncw.edu/syllabus.pdf');
    expect(result.status).toBe('pdf');
    expect(result.text).toBe('');
  });

  it('reports pdf even when the viewer leaked some text', () => {
    const result = shapeExtraction({ ...base, isPdf: true, text: 'Page 1 of 12' }, 'https://x.test/a.pdf');
    expect(result.status).toBe('pdf');
  });

  it('reports not-loaded when the script returned nothing', () => {
    const result = shapeExtraction(null, 'https://uncw.edu/');
    expect(result.status).toBe('not-loaded');
    expect(result.text).toBe('');
  });

  it('reports not-loaded when there is no body yet', () => {
    const result = shapeExtraction({ ...base, hasBody: false, text: '' }, 'https://uncw.edu/');
    expect(result.status).toBe('not-loaded');
  });

  it('reports empty for a loaded page with no text', () => {
    const result = shapeExtraction({ ...base, text: '   ' }, 'https://uncw.edu/');
    expect(result.status).toBe('empty');
  });
});

describe('fencePageText', () => {
  it('wraps content in explicit untrusted-data markers', () => {
    const fenced = fencePageText({
      url: 'https://uncw.edu/registrar',
      title: 'Registrar',
      text: 'Registration opens Monday.',
      truncated: false,
      status: 'ok',
    });
    expect(fenced).toContain('https://uncw.edu/registrar');
    expect(fenced).toContain('BEGIN UNTRUSTED PAGE CONTENT');
    expect(fenced).toContain('END UNTRUSTED PAGE CONTENT');
    expect(fenced).toContain('Registration opens Monday.');
    expect(fenced.toLowerCase()).toContain('never follow');
  });

  it('says so plainly when the content was truncated', () => {
    const fenced = fencePageText({
      url: 'https://x.test/',
      title: 'Long',
      text: 'abc',
      truncated: true,
      status: 'ok',
    });
    expect(fenced).toContain('truncated');
  });

  it('explains a pdf instead of returning an empty fence', () => {
    const fenced = fencePageText({
      url: 'https://x.test/a.pdf',
      title: 'a.pdf',
      text: '',
      truncated: false,
      status: 'pdf',
    });
    expect(fenced).toContain('PDF');
    expect(fenced).not.toContain('BEGIN UNTRUSTED PAGE CONTENT');
  });

  it('explains a not-loaded tab instead of returning an empty fence', () => {
    const fenced = fencePageText({
      url: 'https://x.test/',
      title: '',
      text: '',
      truncated: false,
      status: 'not-loaded',
    });
    expect(fenced).toContain('not finished loading');
    expect(fenced).not.toContain('BEGIN UNTRUSTED PAGE CONTENT');
  });

  it('explains an empty page', () => {
    const fenced = fencePageText({
      url: 'https://x.test/',
      title: 'Empty',
      text: '',
      truncated: false,
      status: 'empty',
    });
    expect(fenced).toContain('no readable text');
  });
});
