/** The workspaces: the tenancy native's fields, plus where its invoices go and its plan's slug. */
export type Tenant = {
  key: string;
  plan?: string;
  strategy?: "schema" | "database";
  schema?: string;
  connection?: string;
  status: "active" | "suspended";
  attributes?: { region?: string };
  /** @format email */
  billingEmail?: string;
  planSlug?: string;
};
