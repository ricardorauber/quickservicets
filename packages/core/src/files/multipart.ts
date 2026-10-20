/** One part of a multipart body: its name, the file name and Content-Type of a file part, and where its bytes are. */
export interface MultipartPart {
  name: string;
  /** Set for a file part (a part whose disposition has `filename` or `filename*`). */
  filename?: string;
  /** The part's Content-Type header, when it has one. */
  type?: string;
  start: number;
  end: number;
}

/** A size limit checked while the body is still arriving, so an oversized file can be refused before it is all read. */
export interface MultipartLimit {
  /** The checked part: the first part with this name, when it is a file part. */
  name: string;
  /** The size past which `check` runs. */
  maxSize: number;
  /** How many leading bytes `check` needs; it runs once at least that many (or the whole part) arrived. */
  headSize: number;
  /** Throws the error the request must answer, or returns when the answer cannot be told from these bytes. */
  check(part: { type: string; head: Uint8Array }): void;
}

const CR = 13;
const LF = 10;
const DASH = 45;
const SPACE = 32;
const TAB = 9;
const HEADERS_END = Buffer.from("\r\n\r\n");
const BOUNDARY = /boundary=(?:"([^"]+)"|([^;\s]+))/i;

/** The boundary of a multipart Content-Type header, or undefined when it has none. */
export function boundaryOf(contentType: string): string | undefined {
  const match = BOUNDARY.exec(contentType);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** The parse errors are TypeErrors with the messages of the runtime's own form parser. */
const parseError = (problem: string) => new TypeError(`FormData parse error ${problem}`);

/** The parameters of a header value such as `form-data; name="a"; filename="b.txt"`, with lower-case keys. */
function headerParameters(value: string): { kind: string; parameters: Map<string, string> } {
  const parameters = new Map<string, string>();
  let index = value.indexOf(";");
  const kind = (index === -1 ? value : value.slice(0, index)).trim().toLowerCase();
  while (index !== -1 && index < value.length) {
    index++;
    const equals = value.indexOf("=", index);
    if (equals === -1) break;
    const key = value.slice(index, equals).trim().toLowerCase();
    let cursor = equals + 1;
    while (value[cursor] === " " || value[cursor] === "\t") cursor++;
    let parameter: string;
    if (value[cursor] === '"') {
      // A quoted value ends at the first quote that is not escaped; its text is kept as sent.
      let close = cursor + 1;
      while (close < value.length && !(value[close] === '"' && value[close - 1] !== "\\")) close++;
      parameter = value.slice(cursor + 1, close);
      index = value.indexOf(";", close);
    } else {
      const semicolon = value.indexOf(";", cursor);
      parameter = value.slice(cursor, semicolon === -1 ? value.length : semicolon).trim();
      index = semicolon;
    }
    if (!parameters.has(key)) parameters.set(key, parameter);
  }
  return { kind, parameters };
}

/** Decodes an RFC 5987 extended value (`charset'language'percent-encoded`), or undefined when it cannot be read. */
function extendedValue(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match) return undefined;
  const charset = match[1]!.toLowerCase();
  try {
    if (charset === "utf-8") return decodeURIComponent(match[2]!);
    if (charset === "iso-8859-1") return match[2]!.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  } catch {
    return undefined;
  }
  return undefined;
}

interface OpenPart {
  name?: string;
  filename?: string;
  type?: string;
  start: number;
  /** Whether the limit applies to this part and has not run yet. */
  limited: boolean;
}

/**
 * Reads a multipart/form-data body in one pass as its chunks arrive: the boundary, each part's headers and where
 * each part's bytes are, without copying them. Malformed bodies fail as the runtime's own form parser fails.
 */
export class MultipartReader {
  private buffer: Buffer;
  private length = 0;
  private state: "preamble" | "delimiter" | "headers" | "data" | "done" = "preamble";
  private cursor = 0;
  /** Where the search for the end of the current headers resumes. */
  private scan = 0;
  private part: OpenPart | undefined;
  private readonly delimiter: Buffer;
  private readonly next: Buffer;
  private readonly names = new Set<string>();
  readonly parts: MultipartPart[] = [];

  constructor(
    boundary: string,
    sizeHint = 0,
    private readonly limit?: MultipartLimit,
  ) {
    this.delimiter = Buffer.from(`--${boundary}`);
    this.next = Buffer.from(`\r\n--${boundary}`);
    this.buffer = Buffer.allocUnsafe(Math.min(Math.max(sizeHint, 1024), 16 * 1024 ** 2));
  }

  /** Adds the next chunk of the body and reads as far as it allows. */
  push(chunk: Uint8Array): void {
    if (this.state === "done" || chunk.length === 0) return;
    if (this.length + chunk.length > this.buffer.length) {
      const grown = Buffer.allocUnsafe(Math.max(this.buffer.length * 2, this.length + chunk.length));
      this.buffer.copy(grown, 0, 0, this.length);
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
    this.advance(false);
  }

  /** Finishes the body: the whole body and its parts, or the error of a body that ended too early. */
  end(): { body: Buffer; parts: MultipartPart[] } {
    this.advance(true);
    return { body: this.buffer.subarray(0, this.length), parts: this.parts };
  }

  private advance(final: boolean): void {
    const body = this.buffer.subarray(0, this.length);
    for (;;) {
      switch (this.state) {
        case "done":
          return;
        case "preamble": {
          const found = body.indexOf(this.delimiter, this.cursor);
          if (found === -1) {
            if (final) throw parseError("missing final boundary");
            this.cursor = Math.max(0, this.length - this.delimiter.length + 1);
            return;
          }
          this.cursor = found + this.delimiter.length;
          this.state = "delimiter";
          break;
        }
        case "delimiter": {
          // After a delimiter: `--` closes the body; otherwise optional padding and CRLF start the next part.
          let position = this.cursor;
          if (body[position] === DASH && position + 1 < this.length) {
            if (body[position + 1] === DASH) {
              this.state = "done";
              return;
            }
          }
          while (body[position] === SPACE || body[position] === TAB) position++;
          if (position + 1 >= this.length) {
            if (final) throw parseError("missing final boundary");
            return;
          }
          if (body[position] !== CR || body[position + 1] !== LF) {
            // Like the runtime's parser, anything else ends the body with the parts read so far.
            this.state = "done";
            return;
          }
          this.cursor = position + 2;
          this.state = "headers";
          break;
        }
        case "headers": {
          const found = body.indexOf(HEADERS_END, Math.max(this.cursor, this.scan));
          if (found === -1) {
            if (final) throw parseError("is missing header end");
            this.scan = Math.max(this.cursor, this.length - HEADERS_END.length + 1);
            return;
          }
          this.part = this.openPart(body.toString("utf8", this.cursor, found), found + HEADERS_END.length);
          this.cursor = this.part.start;
          this.state = "data";
          break;
        }
        case "data": {
          const part = this.part!;
          const found = body.indexOf(this.next, this.cursor);
          if (found === -1) {
            if (final) throw parseError("missing final boundary");
            this.cursor = Math.max(part.start, this.length - this.next.length + 1);
            this.checkLimit(part, this.cursor, false);
            return;
          }
          this.checkLimit(part, found, true);
          if (part.name !== undefined) {
            this.parts.push({ name: part.name, filename: part.filename, type: part.type, start: part.start, end: found });
          }
          this.part = undefined;
          this.cursor = found + this.next.length;
          this.state = "delimiter";
          break;
        }
      }
    }
  }

  private openPart(headers: string, start: number): OpenPart {
    const part: OpenPart = { start, limited: false };
    let file = false;
    for (const line of headers.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) throw parseError("is missing header colon separator");
      const header = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (header === "content-type") part.type = value;
      else if (header === "content-disposition") {
        const { kind, parameters } = headerParameters(value);
        part.name = kind === "form-data" ? parameters.get("name") : undefined;
        const extended = parameters.get("filename*");
        const plain = parameters.get("filename");
        file = extended !== undefined || plain !== undefined;
        part.filename = file ? ((extended === undefined ? undefined : extendedValue(extended)) ?? plain ?? extended) : undefined;
      }
    }
    if (part.name !== undefined) {
      part.limited = file && this.limit?.name === part.name && !this.names.has(part.name);
      this.names.add(part.name);
    }
    return part;
  }

  /** Runs the limit once the part passed its size and enough of it arrived to tell the answer. */
  private checkLimit(part: OpenPart, end: number, complete: boolean): void {
    const limit = this.limit;
    if (!part.limited || !limit) return;
    const size = end - part.start;
    if (size <= limit.maxSize || (!complete && size < limit.headSize)) return;
    part.limited = false;
    const head = this.buffer.subarray(part.start, part.start + Math.min(size, limit.headSize));
    limit.check({ type: new Blob([], { type: part.type ?? "" }).type, head });
  }
}
