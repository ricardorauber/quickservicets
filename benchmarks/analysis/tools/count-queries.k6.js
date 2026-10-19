// Sequential single-VU driver for counting SQL statements per request. OP picks the request mix.
import http from "k6/http";
import { BASE_URL, JSON_HEADERS, RUN_ID, loadFixtures, pick } from "/load/lib.js";

const fixtures = loadFixtures();
const OP = __ENV.OP;
const png = open("/load/fixtures/upload.png", "b");
export const options = { vus: 1, iterations: Number(__ENV.N || 200), discardResponseBodies: false };

function create() {
  const r = http.post(`${BASE_URL}/users`, JSON.stringify({ email: `ops-${RUN_ID}-${Math.random()}@example.com`, name: "Ops", age: 30 }), { headers: JSON_HEADERS });
  if (r.status !== 201) throw new Error(`create ${r.status}`);
  return JSON.parse(r.body).id;
}

export function setup() {
  if (OP === "patch_user") return { id: create() };
  if (OP === "delete_member") {
    // Members of seeded organizations: deleting them must also update the owning organizations.
    return {};
  }
  return {};
}

const ops = {
  health: () => http.get(`${BASE_URL}/health`),
  get_user: () => http.get(`${BASE_URL}/users/${pick(fixtures.users)}`),
  list_users: () => http.get(`${BASE_URL}/users?limit=20&offset=${Math.floor(Math.random() * 9000)}`),
  filter_users: () => http.get(`${BASE_URL}/users?where[role][eq]=admin&where[age][gte]=30&sort=-age,email&fields=email,name&limit=20`),
  populate_orgs: () => http.get(`${BASE_URL}/organizations?populate=members&limit=10`),
  get_org: () => http.get(`${BASE_URL}/organizations/${pick(fixtures.organizations)}`),
  custom: () => http.get(`${BASE_URL}/organizations/${pick(fixtures.organizations)}/stats`),
  create_user: () => create(),
  create_delete: () => {
    const id = create();
    const r = http.del(`${BASE_URL}/users/${id}`);
    if (r.status !== 204) throw new Error(`delete ${r.status}`);
  },
  patch_user: (data) => http.patch(`${BASE_URL}/users/${data.id}`, JSON.stringify({ name: `P${__ITER}` }), { headers: JSON_HEADERS }),
  delete_member: () => {
    // Deletes seeded users that belong to organizations (each seeded user is in exactly one organization).
    const id = fixtures.users[__ITER];
    const r = http.del(`${BASE_URL}/users/${id}`);
    if (r.status !== 204) throw new Error(`delete ${r.status} ${r.body}`);
  },
  upload: () => http.post(`${BASE_URL}/media`, { file: http.file(png, "upload.png", "image/png") }),
  create_conflict: () => http.post(`${BASE_URL}/users`, JSON.stringify({ email: "user00000@example.com", name: "Dup" }), { headers: JSON_HEADERS }),
};

export default function (data) {
  ops[OP](data);
}
