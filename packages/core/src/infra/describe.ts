import { INFRA_CATALOG, isInfraKind, type InfraKind } from "./catalog.ts";

/** An external service a feature needs, as its `infra` field declares it. */
export interface InfraRequirement {
  /** The service's name, shared by requirements meaning the same service: lowercase letters, digits and dashes. */
  name: string;
  /** A kind of the catalog, or `custom` with its own `image` and `ports`. */
  kind: InfraKind | "custom";
  /** One sentence on what the feature uses the service for. */
  description: string;
  /**
   * The connection variables the service gives the project, as templates with `{host}`, `{port}` (the first container
   * port), `{port:<container port>}`, `{user}`, `{password}` and `{database}`.
   */
  env: Readonly<Record<string, string>>;
  /** Tools may leave the service out (default false). */
  optional?: boolean;
  /** The image, for `custom` (required) or to replace the catalog's. */
  image?: string;
  /** The container ports, for `custom` (required) or to replace the catalog's. */
  ports?: readonly number[];
}

/** What the function form of `infra` receives. */
export interface InfraContext<O = Record<string, unknown>> {
  /** The feature's resolved options. */
  options: O;
  /** The resolved configuration. */
  config: Readonly<Record<string, unknown>>;
}

/** The `infra` field of a feature definition: a list of requirements, or a function of the resolved options returning one. */
export type FeatureInfra<O = Record<string, unknown>> = readonly InfraRequirement[] | { method(context: InfraContext<O>): InfraRequirement[] }["method"];

/** One service of an infrastructure description. */
export interface InfraService {
  name: string;
  kind: InfraKind | "custom";
  description: string;
  image: string;
  /** The container ports; the first one is `{port}`. */
  ports: readonly number[];
  /** The health check command, as Docker's `test` list; none for a custom service. */
  health?: readonly string[];
  /** The credentials of the local container. */
  credentials: { user?: string; password?: string; database?: string };
  /** Variables of the container itself. */
  environment: Record<string, string>;
  /** Replaces the image's command. */
  command?: readonly string[];
  /** The folder of the service's data inside the container. */
  data?: string;
  /** The connection variables the service gives the project, as templates. */
  env: Record<string, string>;
  /** True when every requirement of the service is optional. */
  optional: boolean;
  /** Who needs the service: feature keys, `database` or `storage <name>`. */
  owners: string[];
}

/** What `describeInfrastructure` returns: the services, and every connection variable of them as templates. */
export interface InfraDescription {
  services: InfraService[];
  env: Record<string, string>;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const PLACEHOLDER = /\{([a-z]+)(?::(\d+))?\}/g;
const PLACEHOLDERS = new Set(["host", "port", "user", "password", "database"]);

/** Why a requirement is not well formed, or undefined when it is. */
export function infraRequirementProblem(requirement: unknown): string | undefined {
  if (typeof requirement !== "object" || requirement === null || Array.isArray(requirement)) return "a requirement must be { name, kind, description, env }";
  const { name, kind, description, env, optional, image, ports } = requirement as Record<string, unknown>;
  if (typeof name !== "string" || !NAME.test(name)) return "the name must match ^[a-z][a-z0-9-]*$";
  if (kind !== "custom" && !isInfraKind(kind)) return `unknown kind ${JSON.stringify(kind)}; use a catalog kind or custom`;
  if (typeof description !== "string" || description === "") return "description is required";
  if (optional !== undefined && typeof optional !== "boolean") return "optional must be a boolean";
  if (image !== undefined && (typeof image !== "string" || image === "")) return "image must be an image name with a tag";
  if (ports !== undefined && (!Array.isArray(ports) || ports.length === 0 || !ports.every((port) => Number.isInteger(port) && port > 0 && port < 65536))) return "ports must be a list of container ports";
  if (kind === "custom" && image === undefined) return "a custom requirement needs image";
  if (kind === "custom" && ports === undefined) return "a custom requirement needs ports";
  if (typeof env !== "object" || env === null || Array.isArray(env)) return "env must map variable names to templates";
  const servicePorts = (ports as number[] | undefined) ?? (isInfraKind(kind) ? INFRA_CATALOG[kind].ports : []);
  for (const [variable, template] of Object.entries(env)) {
    if (!VARIABLE.test(variable)) return `invalid variable name ${variable}: use ^[A-Z][A-Z0-9_]*$`;
    if (typeof template !== "string") return `the template of ${variable} must be a text`;
    for (const [, placeholder, port] of template.matchAll(PLACEHOLDER)) {
      if (!PLACEHOLDERS.has(placeholder!) || (port !== undefined && placeholder !== "port")) return `unknown placeholder {${placeholder}${port ? `:${port}` : ""}} in ${variable}`;
      if (port !== undefined && !servicePorts.includes(Number(port))) return `${variable} uses {port:${port}}, which is not a port of the service`;
    }
  }
  return undefined;
}

/** Fails with `Invalid infra <name> of <key>: <reason>` for the first requirement that is not well formed. */
export function assertInfraRequirements(key: string, requirements: unknown): readonly InfraRequirement[] {
  if (!Array.isArray(requirements)) throw new Error(`Invalid infra of ${key}: infra must be a list of requirements or a function returning one`);
  for (const requirement of requirements) {
    const problem = infraRequirementProblem(requirement);
    if (problem) throw new Error(`Invalid infra ${String((requirement as { name?: unknown } | null)?.name ?? "requirement")} of ${key}: ${problem}`);
  }
  return requirements as readonly InfraRequirement[];
}

/** What a template is resolved against: the host, the host port of each container port and the credentials. */
export interface InfraEndpoint {
  host: string;
  /** The host port of each container port. */
  ports: Readonly<Record<number, number>>;
  credentials?: { user?: string; password?: string; database?: string };
}

/** A template with its placeholders replaced; `{port}` is the host port of the service's first container port. */
export function resolveInfraTemplate(template: string, service: Pick<InfraService, "ports" | "credentials">, endpoint: InfraEndpoint): string {
  const credentials = { ...service.credentials, ...endpoint.credentials };
  return template.replace(PLACEHOLDER, (whole, placeholder: string, port?: string) => {
    if (placeholder === "host") return endpoint.host;
    if (placeholder === "port") {
      const container = port === undefined ? service.ports[0]! : Number(port);
      return String(endpoint.ports[container] ?? container);
    }
    const value = credentials[placeholder as keyof typeof credentials];
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

/** The connection variables of services resolved against their endpoints, by service name. */
export function resolveInfraEnv(services: readonly InfraService[], endpoints: Readonly<Record<string, InfraEndpoint>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const service of services) {
    const endpoint = endpoints[service.name];
    if (!endpoint) continue;
    for (const [variable, template] of Object.entries(service.env)) env[variable] = resolveInfraTemplate(template, service, endpoint);
  }
  return env;
}

/** The parts of a resolved configuration the description reads. */
interface DescribedConfig {
  database?: { kind?: string };
  storage?: Record<string, unknown>;
  features?: readonly { key: string; options: Record<string, unknown>; definition: { infra?: FeatureInfra } }[];
}

/** The service of a requirement, before merging. */
function serviceOf(requirement: InfraRequirement, owner: string): InfraService {
  const entry = requirement.kind === "custom" ? undefined : INFRA_CATALOG[requirement.kind];
  return {
    name: requirement.name,
    kind: requirement.kind,
    description: requirement.description,
    image: requirement.image ?? entry!.image,
    ports: [...(requirement.ports ?? entry!.ports)],
    ...(entry ? { health: entry.health } : {}),
    credentials: { ...entry?.credentials },
    environment: { ...entry?.environment },
    ...(entry?.command ? { command: entry.command } : {}),
    ...(entry?.data ? { data: entry.data } : {}),
    env: { ...requirement.env },
    optional: requirement.optional === true,
    owners: [owner],
  };
}

/** The S3 bucket of a storage the S3 adapter serves without an explicit endpoint, or undefined. */
function localS3Bucket(storage: unknown): string | undefined {
  const described = (storage as { describe?: () => { kind?: string; bucket?: string; endpoint?: string } } | undefined)?.describe?.();
  return described?.kind === "s3" && !described.endpoint ? (described.bucket ?? "") : undefined;
}

/** The connection variable of a database: `DATABASE_URL` for the default one, `QS_DATABASES_<NAME>_URL` for a named one. */
const databaseVariable = (name: string) => (name === "default" ? "DATABASE_URL" : `QS_DATABASES_${name.replaceAll("-", "_").toUpperCase()}_URL`);

/** The databases of a configuration with their adapter kinds, the default one first. */
function databasesOf(config: DescribedConfig & { databases?: Record<string, { adapter?: { kind?: string } }> }): [string, string | undefined][] {
  const named = Object.entries(config.databases ?? {}).map(([name, entry]): [string, string | undefined] => [name, entry.adapter?.kind]);
  const router = config.database as { databases?: Record<string, { kind?: string }> } | undefined;
  const defaultKind = router?.databases?.default?.kind ?? config.database?.kind;
  return [["default", defaultKind], ...named];
}

/**
 * The external services a configuration needs: one per database served by PostgreSQL or MongoDB (`database`, then
 * `database-<name>` for each named database), `minio` for an S3 storage without an explicit endpoint, and the
 * requirements of every enabled feature, merged by kind and name. It never connects to anything; the running service
 * never reads it.
 */
export function describeInfrastructure(config: DescribedConfig & Record<string, unknown>): InfraDescription {
  const services: InfraService[] = [];
  const variables = new Map<string, { template: string; owner: string }>();
  const add = (service: InfraService) => {
    const owner = service.owners[0]!;
    for (const [variable, template] of Object.entries(service.env)) {
      const previous = variables.get(variable);
      if (previous && previous.template !== template) throw new Error(`${variable} is set by ${previous.owner} and by ${owner}`);
      if (!previous) variables.set(variable, { template, owner });
    }
    const same = services.find((existing) => existing.name === service.name && existing.kind === service.kind);
    if (!same) {
      services.push(service);
      return;
    }
    same.owners.push(...service.owners.filter((name) => !same.owners.includes(name)));
    same.optional &&= service.optional;
    Object.assign(same.environment, service.environment);
    Object.assign(same.env, service.env);
  };
  for (const [name, kind] of databasesOf(config as never)) {
    if (kind !== "postgres" && kind !== "mongodb") continue;
    const entry = INFRA_CATALOG[kind];
    add(serviceOf({ name: name === "default" ? "database" : `database-${name}`, kind, description: `The ${name === "default" ? "default" : name} database.`, env: { [databaseVariable(name)]: entry.templates.DATABASE_URL! } }, name === "default" ? "database" : `databases.${name}`));
  }
  const buckets = Object.entries(config.storage ?? {}).flatMap(([name, storage]) => {
    const bucket = localS3Bucket(storage);
    return bucket === undefined ? [] : [{ name, bucket }];
  });
  if (buckets.length > 0) {
    const service = serviceOf({ name: "minio", kind: "minio", description: "Object storage for the S3 storages without an endpoint.", env: INFRA_CATALOG.minio.templates }, `storage ${buckets[0]!.name}`);
    service.owners = buckets.map((entry) => `storage ${entry.name}`);
    service.environment.QS_BUCKETS = [...new Set(buckets.map((entry) => entry.bucket).filter((bucket) => bucket !== ""))].join(" ");
    add(service);
  }
  for (const feature of config.features ?? []) {
    const infra = feature.definition.infra;
    if (infra === undefined) continue;
    const requirements = typeof infra === "function" ? assertInfraRequirements(feature.key, infra({ options: feature.options, config })) : infra;
    for (const requirement of requirements) add(serviceOf(requirement, feature.key));
  }
  const env = Object.fromEntries([...variables].map(([variable, { template }]) => [variable, template]));
  return { services, env };
}
