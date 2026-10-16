/** How a built-in JSDoc tag appears in the reference documentation. */
export interface TagDoc {
  description: string;
  /** What the tag can be written on, e.g. "Top-level string fields". */
  appliesTo: string;
  example: string;
}

export interface DocumentedTag extends Partial<TagDoc> {
  name: string;
}

/** A registry of tag documentation, listing every registered tag with its description (if any). */
export function tagDocRegistry(registered: () => Iterable<string>) {
  const docs = new Map<string, TagDoc>();
  return {
    describe(name: string, doc: TagDoc): void {
      docs.set(name, doc);
    },
    list(): DocumentedTag[] {
      return [...registered()].map((name) => ({ name, ...docs.get(name) }));
    },
  };
}
