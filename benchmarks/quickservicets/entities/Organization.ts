import type { User } from "./User.ts";

export type Organization = {
  name: string;
  /** @unique */
  slug: string;
  members: User[];
};
