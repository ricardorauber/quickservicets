/** The strong entity tag of a stored record: a hash of its id and `updatedAt`, which changes on every write. */
export function etagOf(record: object): string {
  const { id, updatedAt } = record as { id?: unknown; updatedAt?: unknown };
  const at = updatedAt instanceof Date ? updatedAt.getTime() : typeof updatedAt === "string" || typeof updatedAt === "number" ? new Date(updatedAt).getTime() : 0;
  const digest = new Bun.CryptoHasher("sha256").update(`${String(id)}:${at}`).digest("base64url");
  return `"${digest.slice(0, 22)}"`;
}

/** The tags an `If-None-Match` or `If-Match` header lists, or `*`. */
export function listedTags(header: string): string[] | "*" {
  const value = header.trim();
  if (value === "*") return "*";
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

const opaque = (tag: string) => (tag.startsWith("W/") ? tag.slice(2) : tag);

/** Whether an `If-None-Match` header lists the tag, comparing weakly (`W/` prefixes ignored), or is `*`. */
export function noneMatch(header: string | null, tag: string): boolean {
  if (header === null) return false;
  const tags = listedTags(header);
  return tags === "*" || tags.some((listed) => opaque(listed) === opaque(tag));
}
