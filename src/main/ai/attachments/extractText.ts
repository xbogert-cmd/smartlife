import mammoth from 'mammoth';

/** Reads the real text layer only -- a scanned/image-only PDF yields little
 *  or nothing. No OCR in this phase; see the design spec's Deferred section.
 *
 *  pdfjs-dist's legacy/build/pdf.mjs is ESM-only (no CJS export). The main
 *  process bundle is CJS (electron-vite's externalizeDepsPlugin leaves
 *  node_modules imports as-is, and a static `import` compiles to `require`
 *  there), which crashes on launch with ERR_REQUIRE_ESM -- Vitest's own
 *  module loader doesn't hit this, so the test suite never caught it. A
 *  dynamic import() is real ESM interop that works from CJS in Node, which
 *  Electron's own crash message points at. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      pages.push(pageText);
    }
    return pages.join('\n\n');
  } finally {
    // pdfjs-dist 6.x: PDFDocumentProxy (the resolved doc) has no destroy()
    // method -- only the PDFDocumentLoadingTask returned by getDocument()
    // does, and it internally tears down the transport/doc for us.
    await loadingTask.destroy();
  }
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
