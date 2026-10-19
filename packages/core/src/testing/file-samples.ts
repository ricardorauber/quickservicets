const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Small files that start the way real files of each format do, for upload and type detection tests. */
export const fileSamples = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]),
  gif: new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x3b]),
  webp: new Uint8Array([...ascii("RIFF"), 26, 0, 0, 0, ...ascii("WEBPVP8L"), 13, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 7, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 7, 0]),
  pdf: new Uint8Array(ascii("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n")),
  csv: new Uint8Array(ascii("name,qty\nbolt,4\n")),
};
