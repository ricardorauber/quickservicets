// custom: the hand-written endpoint GET /organizations/{orgId}/stats on random seeded organizations.
import http from "k6/http";
import { BASE_URL, expectStatus, loadFixtures, options as makeOptions, pick, summary } from "./lib.js";

const fixtures = loadFixtures();
export const options = makeOptions(["org_stats"]);

export default function () {
  const res = http.get(`${BASE_URL}/organizations/${pick(fixtures.organizations)}/stats`, { tags: { endpoint: "org_stats", name: "org_stats" } });
  expectStatus(res, 200, "org_stats");
}

export function handleSummary(data) {
  return summary(data);
}
