import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';

/** Reads the real text layer only -- a scanned/image-only PDF yields little
 *  or nothing. No OCR in this phase; see the design spec's Deferred section. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
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
