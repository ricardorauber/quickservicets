// query: filtered, sorted, projected user list plus an organization list with populated members.
import http from "k6/http";
import { BASE_URL, expectStatus, options as makeOptions, summary } from "./lib.js";

export const options = makeOptions(["filter_users", "populate_orgs"]);
const FILTER = "/users?where[role][eq]=admin&where[age][gte]=30&sort=-age,email&fields=email,name&limit=20";
const POPULATE = "/organizations?populate=members&limit=10";

export default function () {
  let res = http.get(`${BASE_URL}${FILTER}`, { tags: { endpoint: "filter_users", name: "filter_users" } });
  expectStatus(res, 200, "filter_users");
  res = http.get(`${BASE_URL}${POPULATE}`, { tags: { endpoint: "populate_orgs", name: "populate_orgs" } });
  expectStatus(res, 200, "populate_orgs");
}

export function handleSummary(data) {
  return summary(data);
}
