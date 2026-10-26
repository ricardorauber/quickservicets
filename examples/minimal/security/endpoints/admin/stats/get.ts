import type { Endpoint } from "@quickservicets/core";

/**
 * Counts the records; only the private network and the machine itself may ask.
 * @ipAllow private,loopback
 */
const stats: Endpoint<unknown, { posts: number; customers: number }> = async (repos) => ({
  posts: await repos.posts.query().count(),
  customers: await repos.customers.query().count(),
});

export default stats;
