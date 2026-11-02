/**
 * A plan a workspace subscribes to, with its limits; shared by every tenant.
 * @tenancy shared
 */
export type Plan = {
  /** @unique */
  slug: string;
  /** The most active projects; without it, unlimited. */
  maxProjects?: number;
  /** The most members; without it, unlimited. */
  maxMembers?: number;
};
