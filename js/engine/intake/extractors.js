// Browser-only file routing: vendor file -> { kind:'text', text } | { kind:'image', dataUrl }.
// Depends on CDN globals (XLSX, pdfjsLib, mammoth) — loaded in index.html.
// Kept separate from the DOM-free engine so Node tests can import everything else.

export async function routeFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.email')) return { kind: 'text', text: await file.text() };
  if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) {
    return { kind: 'image', dataUrl: await blobToDataUrl(file) };
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return { kind: 'text', text: await xlsxToText(file) };
  if (name.endsWith('.pdf')) return { kind: 'text', text: await pdfToText(file) };
  if (name.endsWith('.docx')) return { kind: 'text', text: await docxToText(file) };
  throw new Error(`Unsupported file type: ${file.name}`);
}

// Demo loader: fetch a sample vendor file from data/vendors/ and route it like an upload.
export async function loadDemoFile(relativePath, fileName) {
  const res = await fetch(relativePath);
  if (!res.ok) throw new Error(`Could not load ${relativePath}`);
  const blob = await res.blob();
  return routeFile(new File([blob], fileName, { type: blob.type }));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function xlsxToText(file) {
  if (!window.XLSX) throw new Error('SheetJS (XLSX) failed to load from CDN');
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: 'array' });
  const out = [];
  for (const sheet of wb.SheetNames) {
    out.push(`--- sheet: ${sheet} ---`);
    out.push(window.XLSX.utils.sheet_to_csv(wb.Sheets[sheet]));
  }
  return out.join('\n');
}

async function pdfToText(file) {
  if (!window.pdfjsLib) throw new Error('pdf.js failed to load from CDN');
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(`--- page ${i} ---`);
    pages.push(tc.items.map(it => it.str).join(' '));
  }
  return pages.join('\n');
}

async function docxToText(file) {
  if (!window.mammoth) throw new Error('mammoth failed to load from CDN');
  const buf = await file.arrayBuffer();
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return value;
}
