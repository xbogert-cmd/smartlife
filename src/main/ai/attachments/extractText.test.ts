import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

const MINIMAL_PDF_WITH_TEXT = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 58>>stream
BT /F1 18 Tf 10 50 Td (Hello from a test PDF) Tj ET
endstream
endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`,
  'utf8'
);

async function buildMinimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractPdfText', () => {
  it('extracts the visible text from a simple one-page PDF', async () => {
    const { extractPdfText } = await import('./extractText');
    const text = await extractPdfText(MINIMAL_PDF_WITH_TEXT);
    expect(text).toContain('Hello from a test PDF');
  });
});

describe('extractDocxText', () => {
  it('extracts the paragraph text from a minimal .docx', async () => {
    const { extractDocxText } = await import('./extractText');
    const buffer = await buildMinimalDocx('Hello from a test document');
    const text = await extractDocxText(buffer);
    expect(text).toContain('Hello from a test document');
  });
});
