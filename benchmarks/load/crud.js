// crud: one iteration = read a seeded user, list a page, create a user, update it, delete it.
import http from "k6/http";
import { BASE_URL, JSON_HEADERS, RUN_ID, expectStatus, loadFixtures, options as makeOptions, pick, summary } from "./lib.js";

const fixtures = loadFixtures();
const ENDPOINTS = ["get_user", "list_users", "create_user", "patch_user", "delete_user"];
export const options = makeOptions(ENDPOINTS);
const tag = (endpoint) => ({ endpoint, name: endpoint });

export default function () {
  let res = http.get(`${BASE_URL}/users/${pick(fixtures.users)}`, { tags: tag("get_user") });
  expectStatus(res, 200, "get_user");

  const offset = Math.floor(Math.random() * (fixtures.users.length - 20));
  res = http.get(`${BASE_URL}/users?limit=20&offset=${offset}`, { tags: tag("list_users") });
  expectStatus(res, 200, "list_users");

  const body = { email: `k6-${RUN_ID}-${__VU}-${__ITER}@example.com`, name: `Load ${__VU}-${__ITER}`, role: "member", age: 20 + (__ITER % 60) };
  res = http.post(`${BASE_URL}/users`, JSON.stringify(body), { headers: JSON_HEADERS, responseType: "text", tags: tag("create_user") });
  if (!expectStatus(res, 201, "create_user")) return;
  const id = res.json("id");

  res = http.patch(`${BASE_URL}/users/${id}`, JSON.stringify({ name: `Updated ${__VU}-${__ITER}`, age: 21 + (__ITER % 60) }), {
    headers: JSON_HEADERS,
    tags: tag("patch_user"),
  });
  expectStatus(res, 200, "patch_user");

  res = http.del(`${BASE_URL}/users/${id}`, null, { tags: tag("delete_user") });
  expectStatus(res, 204, "delete_user");
}

export function handleSummary(data) {
  return summary(data);
}
