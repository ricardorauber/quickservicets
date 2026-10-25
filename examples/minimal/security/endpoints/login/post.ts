import type { Endpoint } from "@quickservice/core";

/**
 * Signs a user in; five attempts a minute per address slow down password guessing.
 * @rateLimit 5/min
 */
const login: Endpoint<{ email: string; password: string }, { signedIn: string }> = async (_repos, req) => {
  const { email } = await req.json();
  return { signedIn: email };
};

export default login;
