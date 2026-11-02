/**
 * A user's membership of a workspace: users live in the identity provider, so only their ids are kept.
 * @tenancy shared
 * @uniqueMembership:create
 */
export type Member = {
  /** @index */
  tenantKey: string;
  userId: string;
  role: "owner" | "admin" | "member";
};
