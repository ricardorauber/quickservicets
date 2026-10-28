import { HttpError, type Repositories, type ServiceRequest } from "@quickservicets/core";

let calls = 0;

/** The tenant's feed; one call in five fails, so the usage metrics have errors to count. */
export default async (repos: Repositories, req: ServiceRequest) => {
  calls += 1;
  if (calls % 5 === 0) throw new HttpError(503, "The feed is warming up");
  return (await repos.posts.list({ where: [], sort: [], limit: 20, offset: 0 })).data;
};
