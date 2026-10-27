/**
 * The fields of `req.user` and `req.tenant` in this project. The `requires` hook fills them from the `x-user-id` header
 * and the organization of the route, standing in for real authentication and tenancy.
 */
declare module "@quickservicets/core" {
  interface RequestUser {
    id: string;
  }
  // `req.tenant` already has `id`, `plan` and `attributes`, the fields the tenancy native fills.
}

export {};
