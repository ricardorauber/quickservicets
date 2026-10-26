/**
 * Fills the database with a small, fixed sample dataset through the repositories: `bun run seed`.
 * Every record is looked up by its natural key first (a slug, an email, a module and action...), so running the script
 * again creates only what is missing and never duplicates a record.
 */
import { createRepositories, resolveConfig, type Repositories } from "@quickservicets/core";

type Action = "manage" | "view";

const MODULES = ["organizations", "billing", "reports"] as const;
type ModuleSlug = (typeof MODULES)[number];

const PROFILES: Record<string, `${ModuleSlug}:${Action}`[]> = {
  admin: ["organizations:manage", "billing:manage", "reports:manage"],
  finance: ["billing:manage", "reports:view"],
  viewer: ["organizations:view", "reports:view"],
};

const ORGANIZATIONS = [
  { slug: "acme", legalName: "Acme Inc.", name: "Acme", modules: ["organizations", "billing", "reports"] },
  { slug: "globex", legalName: "Globex LLC", name: "Globex", modules: ["organizations", "reports"] },
] as const;

const USERS = [
  { email: "ana@acme.co", name: "Ana", role: "admin" },
  { email: "bruno@acme.co", name: "Bruno", role: "basic" },
  { email: "carla@globex.co", name: "Carla", role: "basic" },
] as const;

const MEMBERSHIPS = [
  { organization: "acme", user: "ana@acme.co", profiles: ["admin"] },
  { organization: "acme", user: "bruno@acme.co", profiles: ["finance"] },
  { organization: "globex", user: "carla@globex.co", profiles: ["viewer"] },
  { organization: "globex", user: "ana@acme.co", profiles: ["viewer"] },
] as const;

const TEAMS = [{ organization: "acme", name: "Data", users: ["ana@acme.co", "bruno@acme.co"], profiles: ["viewer"] }] as const;

/** How many records of each kind the seed created now, and how many were already there. */
export type SeedSummary = Record<"modules" | "permissions" | "profiles" | "organizations" | "users" | "memberships" | "teams", { created: number; existing: number }>;

/** Creates the sample dataset, skipping every record that already exists. */
export async function seed(repos: Repositories): Promise<SeedSummary> {
  const summary = Object.fromEntries(
    ["modules", "permissions", "profiles", "organizations", "users", "memberships", "teams"].map((kind) => [kind, { created: 0, existing: 0 }]),
  ) as SeedSummary;
  async function ensure<T>(kind: keyof SeedSummary, found: T | null, create: () => Promise<T>): Promise<T> {
    if (found) {
      summary[kind].existing++;
      return found;
    }
    summary[kind].created++;
    return create();
  }

  const modules = new Map<string, string>();
  for (const slug of MODULES) {
    const found = await repos.modules.where((m) => m.slug.eq(slug)).firstOrDefault();
    modules.set(slug, (await ensure("modules", found, () => repos.modules.create({ slug }))).id);
  }

  const permissions = new Map<string, string>();
  for (const slug of MODULES) {
    for (const action of ["manage", "view"] as const) {
      const module = modules.get(slug)!;
      const found = await repos.permissions.where((p) => p.module.eq(module).and(p.action.eq(action))).firstOrDefault();
      permissions.set(`${slug}:${action}`, (await ensure("permissions", found, () => repos.permissions.create({ module, action }))).id);
    }
  }

  const profiles = new Map<string, string>();
  for (const [slug, granted] of Object.entries(PROFILES)) {
    const found = await repos.profiles.where((p) => p.slug.eq(slug)).firstOrDefault();
    const create = () => repos.profiles.create({ slug, permissions: granted.map((permission) => permissions.get(permission)!) });
    profiles.set(slug, (await ensure("profiles", found, create)).id);
  }

  const organizations = new Map<string, string>();
  for (const { modules: enabled, ...organization } of ORGANIZATIONS) {
    const found = await repos.organizations.where((o) => o.slug.eq(organization.slug)).firstOrDefault();
    const create = () => repos.organizations.create({ ...organization, modules: enabled.map((slug) => modules.get(slug)!) });
    organizations.set(organization.slug, (await ensure("organizations", found, create)).id);
  }

  const users = new Map<string, string>();
  for (const user of USERS) {
    const found = await repos.users.where((u) => u.email.eq(user.email)).firstOrDefault();
    users.set(user.email, (await ensure("users", found, () => repos.users.create(user))).id);
  }

  for (const membership of MEMBERSHIPS) {
    const organization = organizations.get(membership.organization)!;
    const user = users.get(membership.user)!;
    const found = await repos.memberships.where((m) => m.organization.eq(organization).and(m.user.eq(user))).firstOrDefault();
    const create = () => repos.memberships.create({ organization, user, profiles: membership.profiles.map((slug) => profiles.get(slug)!) });
    await ensure("memberships", found, create);
  }

  for (const team of TEAMS) {
    const organization = organizations.get(team.organization)!;
    const found = await repos.teams.where((t) => t.organization.eq(organization).and(t.name.eq(team.name))).firstOrDefault();
    const create = () =>
      repos.teams.create({
        organization,
        name: team.name,
        users: team.users.map((email) => users.get(email)!),
        profiles: team.profiles.map((slug) => profiles.get(slug)!),
      });
    await ensure("teams", found, create);
  }
  return summary;
}

if (import.meta.main) {
  const { default: projectConfig } = await import("../quickservicets.config.ts");
  const { models } = await import("../.generated/models.ts");
  const config = resolveConfig(projectConfig);
  await config.database.connect(models, { defaultSchema: config.schema });
  try {
    const summary = await seed(createRepositories(models, config.database) as unknown as Repositories);
    for (const [kind, { created, existing }] of Object.entries(summary)) console.log(`${kind}: ${created} created, ${existing} already there`);
  } finally {
    await config.database.disconnect();
  }
}
