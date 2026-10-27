/**
 * A plan every tenant can choose; its records are shared by all of them.
 * @tenancy shared
 */
export type Plan = {
  name: string;
  price: number;
};
