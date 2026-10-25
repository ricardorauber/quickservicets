import type { StoredRecord } from "../adapter.ts";
import type { ServiceRequest } from "../hooks.ts";
import type { EntityModel } from "../model.ts";

/** The record a generated route read or wrote for a request, before field selection. */
export interface StoredRecordOf {
  entity: EntityModel;
  record: StoredRecord;
}

const records = new WeakMap<ServiceRequest, StoredRecordOf>();
let tracking = false;

/**
 * Makes the generated read, create, update and replace routes keep the record they read or wrote for each request, as
 * `storedRecordOf` returns it; features that need it (entity tags) turn it on. Off by default, so routes keep nothing.
 */
export function trackStoredRecords(on: boolean): void {
  tracking = on;
}

/** Keeps the record of a generated route for the request, while tracking is on. */
export function rememberStoredRecord(req: ServiceRequest, entity: EntityModel, record: StoredRecord): void {
  if (tracking) records.set(req, { entity, record });
}

/** The record the generated route of a request read or wrote, before field selection; undefined otherwise. */
export function storedRecordOf(req: ServiceRequest): StoredRecordOf | undefined {
  return records.get(req);
}
