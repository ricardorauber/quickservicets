/** How many leading bytes the signatures need. */
const HEAD_SIZE = 16;

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Byte patterns at the start of a file; `null` matches any byte. */
const SIGNATURES: { type: string; bytes: (number | null)[] }[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: ascii("GIF87a") },
  { type: "image/gif", bytes: ascii("GIF89a") },
  { type: "image/webp", bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WEBP")] },
  { type: "application/pdf", bytes: ascii("%PDF-") },
];

function startsWith(head: Uint8Array, bytes: (number | null)[]): boolean {
  return head.length >= bytes.length && bytes.every((byte, index) => byte === null || head[index] === byte);
}

/** The MIME type of a file recognized from its first bytes, or undefined when the format is not one the server knows. */
export async function detectFileType(file: Blob): Promise<string | undefined> {
  // The global Blob type of the project's libraries leaves out `slice`, which every runtime Blob has.
  const start = (file as Blob & { slice(start: number, end: number): Blob }).slice(0, HEAD_SIZE);
  const head = new Uint8Array(await start.arrayBuffer());
  return SIGNATURES.find((signature) => startsWith(head, signature.bytes))?.type;
}
