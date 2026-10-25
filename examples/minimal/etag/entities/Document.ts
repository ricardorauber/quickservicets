/** @etag required=true */
export type Document = {
  title: string;
  body: string;
  /** @default 1 */
  version: number;
};
