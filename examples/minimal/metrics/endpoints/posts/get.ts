import type { Repositories, ServiceRequest } from "@quickservicets/core";

/** Lists posts, failing when asked to with `?fail=1`, so the usage metrics have errors to count. */
export default (_repos: Repositories, req: ServiceRequest) => {
  if (req.query.get("fail")) throw new Error("Posts are unavailable");
  return [{ title: "Hello" }];
};
