import type { EntityModel, FieldModel } from "./model.ts";

/** A stored file: the type to reference (`logo: File`) or extend (`File & { ... }`) in `/entities`. */
export type File = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  filename: string;
  mimeType: string;
  size: number;
  storage: string;
  storageKey: string;
  url: string;
};

/** A stored image, video or audio file. */
export type Media = File;

export type FileBase = "file" | "media";

/** MIME patterns a Media-based entity accepts. */
export const MEDIA_MIME_TYPES = ["image/*", "video/*", "audio/*"];

/** Fields every file entity has; they are set by uploads, so JSON bodies cannot write them (`filename` only on PATCH). */
export const FILE_BASE_FIELDS: FieldModel[] = [
  { name: "filename", type: "string", optional: false, storage: "column", readOnly: "unlessPatch" },
  { name: "mimeType", type: "string", optional: false, storage: "column", readOnly: "always" },
  { name: "size", type: "number", optional: false, storage: "column", readOnly: "always" },
  { name: "storage", type: "string", optional: false, storage: "column", readOnly: "always" },
  { name: "storageKey", type: "string", optional: false, storage: "column", readOnly: "always", hidden: true },
  // Computed on every read from the access mode; never stored.
  { name: "url", type: "string", optional: false, storage: "computed", readOnly: "always" },
];

const SYSTEM = ["id", "createdAt", "updatedAt"];

/** The built-in `File` or `Media` entity, used when `/entities` does not define it. */
export function builtInFileEntity(base: FileBase): EntityModel {
  const entityName = base === "file" ? "File" : "Media";
  const name = base === "file" ? "files" : "media";
  const fields = FILE_BASE_FIELDS.map((field) => ({ ...field }));
  const include = [...SYSTEM, ...fields.map((field) => field.name)];
  return {
    key: entityName,
    entityName,
    schema: null,
    name,
    repoKey: name,
    tableName: name,
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: false,
    exposure: { list: { include, exclude: ["storageKey"] }, read: { include, exclude: ["storageKey"] } },
    file: { base },
  };
}
