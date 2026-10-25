import type { EntityModel, ServiceRequest, StoredRecord } from "../public.ts";

/** Computes entity tags in place of `etagOf` for the native's routes (`etag.tagger`). */
export interface EntityTagger {
  /** A strong tag for the stored record of `entity` (undefined for a custom endpoint's `res.etag`); quoted when it is not. */
  tag(record: StoredRecord, entity?: EntityModel): string;
}

/** What `onPreconditionFailed` hooks receive; a `Response` one returns replaces the 412. */
export interface PreconditionFailure {
  req: ServiceRequest;
  /** The entity's name. */
  entity: string | undefined;
  id: string | undefined;
  /** The request's `If-Match` value. */
  expected: string;
  /** The record's current tag, or undefined when the record is gone. */
  current: string | undefined;
}

/** What `onNotModified` hooks observe for each 304. */
export interface NotModified {
  req: ServiceRequest;
  /** The entity's name, or undefined for a custom endpoint's `res.etag`. */
  entity: string | undefined;
  id: string | undefined;
}
