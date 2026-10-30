/** A customer, in the default database. */
export type Customer = {
  /** @minLength 1 */
  name: string;
  /** @format email */
  email?: string;
};
