/**
 * Canvas announcement and page bodies are authored by instructors — untrusted
 * third-party HTML. The dev CSP permits inline scripts, so this sanitizer is
 * the primary defence, not a decoration.
 * ponytail: DOMParser + a removal pass beats pulling in a sanitizer dependency.
 */
const FORBIDDEN = 'script,iframe,object,embed,style,link,meta,form,base';

export function sanitizeHtml(html: string): string {
  if (html.length === 0) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const element of Array.from(doc.querySelectorAll(FORBIDDEN))) {
    element.remove();
  }

  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'href' || name === 'src' || name === 'xlink:href') {
        // Browsers strip ASCII tab/newline/CR anywhere in a URL before
        // resolving its scheme, so "java\tscript:" still executes on click
        // even though a plain /^\s*javascript:/ test on the raw value misses
        // it. Normalize those out before testing.
        const normalized = attribute.value.replace(/[\t\n\r]/g, '');
        if (/^\s*javascript:/i.test(normalized)) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }

  return doc.body.innerHTML;
}
