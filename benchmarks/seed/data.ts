/**
 * The deterministic benchmark dataset: 10,000 users and 1,000 organizations with 10 members each.
 *
 * Everything (ids, timestamps, roles, ages, memberships) comes from a fixed-seed PRNG, so every run and every
 * stack starts from byte-identical rows. The conformance test imports this module to compute golden answers.
 */

export const SEED = 20261019;
export const USER_COUNT = 10_000;
export const ORGANIZATION_COUNT = 1_000;
export const MEMBERS_PER_ORGANIZATION = 10;

/** Users are created one second apart from this instant, organizations one second apart from the next. */
export const USERS_START = Date.parse("2026-01-01T00:00:00.000Z");
export const ORGANIZATIONS_START = Date.parse("2026-02-01T00:00:00.000Z");

export type SeedUser = {
  id: string;
  createdAt: string;
  updatedAt: string;
  email: string;
  name: string;
  role: "member" | "admin";
  age: number | null;
};

export type SeedOrganization = {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  slug: string;
  /** Member user ids, in position order (position = index). */
  members: string[];
};

export type Dataset = { users: SeedUser[]; organizations: SeedOrganization[] };

/** mulberry32: a small, fast, well-distributed 32-bit PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (value: number, digits: number) => value.toString(16).padStart(digits, "0");

/** A UUID v7 (RFC 9562) for the given millisecond timestamp, with PRNG-provided random bits. */
function uuidv7(ms: number, random: () => number): string {
  const r = () => Math.floor(random() * 0x10000);
  const time = hex(ms, 12);
  const randA = 0x7000 | (r() & 0x0fff);
  const randB = 0x8000 | (r() & 0x3fff);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-${hex(randA, 4)}-${hex(randB, 4)}-${hex(r(), 4)}${hex(r(), 4)}${hex(r(), 4)}`;
}

let cached: Dataset | undefined;

export function generateDataset(): Dataset {
  if (cached) return cached;
  const random = prng(SEED);

  const users: SeedUser[] = [];
  for (let i = 0; i < USER_COUNT; i++) {
    const ms = USERS_START + i * 1000;
    const timestamp = new Date(ms).toISOString();
    const role = random() < 0.2 ? "admin" : "member";
    const age = random() < 0.1 ? null : 18 + Math.floor(random() * 63);
    users.push({
      id: uuidv7(ms, random),
      createdAt: timestamp,
      updatedAt: timestamp,
      email: `user${String(i).padStart(5, "0")}@example.com`,
      name: `User ${i}`,
      role,
      age,
    });
  }

  // Fisher-Yates shuffle of the user indexes; organization j gets the j-th slice of 10.
  const order = users.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  const organizations: SeedOrganization[] = [];
  for (let j = 0; j < ORGANIZATION_COUNT; j++) {
    const ms = ORGANIZATIONS_START + j * 1000;
    const timestamp = new Date(ms).toISOString();
    const slice = order.slice(j * MEMBERS_PER_ORGANIZATION, (j + 1) * MEMBERS_PER_ORGANIZATION);
    organizations.push({
      id: uuidv7(ms, random),
      createdAt: timestamp,
      updatedAt: timestamp,
      name: `Organization ${j}`,
      slug: `org-${String(j).padStart(4, "0")}`,
      members: slice.map((index) => users[index]!.id),
    });
  }

  cached = { users, organizations };
  return cached;
}
