// Single-endpoint variants, for profiling one code path at a time. ENDPOINT picks the request:
//   health | get_user | list_users | create_user | filter_users | populate_orgs
import http from "k6/http";
import { BASE_URL, JSON_HEADERS, RUN_ID, expectStatus, loadFixtures, options as makeOptions, pick, summary } from "./lib.js";

const fixtures = loadFixtures();
const ENDPOINT = __ENV.ENDPOINT || "health";

const requests = {
  health: () => [http.get(`${BASE_URL}/health`, params()), 200],
  get_user: () => [http.get(`${BASE_URL}/users/${pick(fixtures.users)}`, params()), 200],
  list_users: () => [http.get(`${BASE_URL}/users?limit=20&offset=${Math.floor(Math.random() * (fixtures.users.length - 20))}`, params()), 200],
  create_user: () => [
    http.post(`${BASE_URL}/users`, JSON.stringify({ email: `k6-${RUN_ID}-${__VU}-${__ITER}@example.com`, name: `Load ${__VU}-${__ITER}`, age: 20 + (__ITER % 60) }), {
      ...params(),
      headers: JSON_HEADERS,
    }),
    201,
  ],
  filter_users: () => [http.get(`${BASE_URL}/users?where[role][eq]=admin&where[age][gte]=30&sort=-age,email&fields=email,name&limit=20`, params()), 200],
  populate_orgs: () => [http.get(`${BASE_URL}/organizations?populate=members&limit=10`, params()), 200],
};

if (!requests[ENDPOINT]) throw new Error(`Unknown ENDPOINT ${ENDPOINT}`);
export const options = makeOptions([ENDPOINT]);

function params() {
  return { tags: { endpoint: ENDPOINT, name: ENDPOINT } };
}

export default function () {
  const [res, status] = requests[ENDPOINT]();
  expectStatus(res, status, ENDPOINT);
}

export function handleSummary(data) {
  return summary(data);
}
