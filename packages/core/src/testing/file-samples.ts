import { deflateRawSync } from "node:zlib";

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** A ZIP archive with the given entries, stored or deflated; a name ending in `/` is a folder entry. */
export function zipSample(entries: Record<string, string>, options: { deflate?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(content);
    const method = options.deflate && raw.length > 0 ? 8 : 0;
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = Bun.hash.crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, centrals.length, true);
  endView.setUint16(10, centrals.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const officeContentTypes = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="xml" ContentType="application/xml"/><Override PartName="/main.xml" ContentType="${main}"/></Types>`;

const OFFICE = "application/vnd.openxmlformats-officedocument";

/** Small files that start the way real files of each format do, for upload and type detection tests. */
export const fileSamples = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]),
  gif: new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x3b]),
  webp: new Uint8Array([...ascii("RIFF"), 26, 0, 0, 0, ...ascii("WEBPVP8L"), 13, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 7, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 7, 0]),
  pdf: new Uint8Array(ascii("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n")),
  csv: new Uint8Array(ascii("name,qty\nbolt,4\n")),
  zip: zipSample({ "notes.txt": "hello", "images/": "" }),
  docx: zipSample({ "[Content_Types].xml": officeContentTypes(`${OFFICE}.wordprocessingml.document.main+xml`), "word/document.xml": "<w:document/>" }, { deflate: true }),
  xlsx: zipSample({ "[Content_Types].xml": officeContentTypes(`${OFFICE}.spreadsheetml.sheet.main+xml`), "xl/workbook.xml": "<workbook/>" }, { deflate: true }),
  pptx: zipSample({ "[Content_Types].xml": officeContentTypes(`${OFFICE}.presentationml.presentation.main+xml`), "ppt/presentation.xml": "<p:presentation/>" }, { deflate: true }),
  mp4: new Uint8Array([0, 0, 0, 24, ...ascii("ftypisom"), 0, 0, 2, 0, ...ascii("isomiso2"), 0, 0, 0, 8, ...ascii("free")]),
  webm: new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0xf2, 0x81, 4, 0x42, 0xf3, 0x81, 8,
    0x42, 0x82, 0x84, ...ascii("webm"), 0x42, 0x87, 0x81, 4, 0x42, 0x85, 0x81, 2, 0x18, 0x53, 0x80, 0x67,
  ]),
  mp3: new Uint8Array([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]),
  mp3Frame: new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]),
};
