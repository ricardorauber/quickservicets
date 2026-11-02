import type { Repositories, ServiceRequest, ServiceResponse } from "@quickservicets/core";
import { signUp, type Signup } from "../../lib/signup.ts";

/**
 * Self-service sign-up: provisions the workspace on its plan and makes the caller its owner, answering 201 with the
 * workspace id; answered without a tenant and limited to 5 sign-ups an hour per address.
 * @tenancy off
 * @rateLimit 5/h
 */
export default async (repos: Repositories, req: ServiceRequest, res: ServiceResponse) => {
  const body = ((await req.json()) ?? {}) as Partial<Signup>;
  const created = await signUp(repos, { workspace: body.workspace!, plan: body.plan!, owner: body.owner ?? "owner", ...(body.billingEmail ? { billingEmail: body.billingEmail } : {}) });
  res.status(201);
  return created;
};
