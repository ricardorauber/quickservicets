import type { Media } from "@quickservicets/core";

/** A file uploaded to the S3 storage, MinIO on the local services. */
export type Attachment = Media & { caption?: string };
