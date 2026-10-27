/**
 * The fields of `req.user` and `req.tenant` in this project. The `requires` hook fills them from the `x-user-id` header
 * and the organization of the route, standing in for real authentication and tenancy.
 */
declare module "@quickservicets/core" {
  interface RequestUser {
    id: string;
  }
  interface RequestTenant {
    id: string;
    plan: "free" | "pro";
  }
}

export {};
