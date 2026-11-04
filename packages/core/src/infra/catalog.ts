/**
 * The external services QuickService.ts knows how to run locally, by kind: a pinned image, the container ports, a
 * health command, the credentials for local use and the connection templates a requirement of that kind usually
 * sets. Local environments, test containers and deploy generators read every service from here, so an image is
 * upgraded in one place.
 */

/** One kind of service of the catalog. */
export interface InfraCatalogEntry {
  /** The image with an exact tag (never `latest`), so every machine runs the same version. */
  image: string;
  /** The container ports the service listens on; the first one is `{port}` in templates. */
  ports: readonly number[];
  /** The command a container health check runs, as Docker's `test` list (`CMD` or `CMD-SHELL` first). */
  health: readonly string[];
  /** The credentials of the local container: `{user}`, `{password}` and `{database}` in templates. */
  credentials: { readonly user?: string; readonly password?: string; readonly database?: string };
  /** Variables of the container itself, like the root password of the image. */
  environment?: Readonly<Record<string, string>>;
  /** Replaces the image's command, as a list. */
  command?: readonly string[];
  /** The folder inside the container that holds the service's data, kept in a named volume. */
  data?: string;
  /** The connection variables a requirement of this kind usually sets, as templates. */
  templates: Readonly<Record<string, string>>;
  /** One sentence on what the service is. */
  description: string;
}

/** The kinds of the catalog. */
export const INFRA_KINDS = [
  "postgres",
  "mongodb",
  "redis",
  "rabbitmq",
  "kafka",
  "localstack",
  "minio",
  "azurite",
  "vault",
  "keycloak",
  "meilisearch",
  "typesense",
  "opensearch",
  "consul",
  "etcd",
  "clamav",
  "mailpit",
  "otel-collector",
  "jaeger",
  "ollama",
] as const;

/** A kind of the catalog. */
export type InfraKind = (typeof INFRA_KINDS)[number];

/** The catalog of service kinds. */
export const INFRA_CATALOG: Readonly<Record<InfraKind, InfraCatalogEntry>> = {
  postgres: {
    image: "postgres:17.11-alpine",
    ports: [5432],
    health: ["CMD-SHELL", "pg_isready -U postgres"],
    credentials: { user: "postgres", password: "postgres", database: "app" },
    environment: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app" },
    data: "/var/lib/postgresql/data",
    templates: { DATABASE_URL: "postgres://{user}:{password}@{host}:{port}/{database}" },
    description: "PostgreSQL database server.",
  },
  mongodb: {
    image: "mongo:7.0.16",
    ports: [27017],
    // A single-node replica set, so transactions work; the check initiates it once and then reports its state.
    health: ["CMD-SHELL", "mongosh --quiet --eval \"try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }).ok }\" | grep -q 1"],
    credentials: { database: "app" },
    command: ["mongod", "--replSet", "rs0", "--bind_ip_all"],
    data: "/data/db",
    templates: { DATABASE_URL: "mongodb://{host}:{port}/{database}?replicaSet=rs0&directConnection=true" },
    description: "MongoDB as a single-node replica set, so transactions work.",
  },
  redis: {
    image: "redis:7.4.1-alpine",
    ports: [6379],
    health: ["CMD", "redis-cli", "ping"],
    credentials: {},
    data: "/data",
    templates: { REDIS_URL: "redis://{host}:{port}" },
    description: "Redis key-value store.",
  },
  rabbitmq: {
    image: "rabbitmq:4.0.5-management-alpine",
    ports: [5672, 15672],
    health: ["CMD", "rabbitmq-diagnostics", "-q", "ping"],
    credentials: { user: "guest", password: "guest" },
    data: "/var/lib/rabbitmq",
    templates: { AMQP_URL: "amqp://{user}:{password}@{host}:{port}" },
    description: "RabbitMQ message broker with its management console.",
  },
  kafka: {
    image: "apache/kafka:3.9.0",
    ports: [9092],
    health: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null 2>&1"],
    credentials: {},
    // KRaft mode, without ZooKeeper: one node is both broker and controller.
    environment: {
      KAFKA_NODE_ID: "1",
      KAFKA_PROCESS_ROLES: "broker,controller",
      KAFKA_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093",
      KAFKA_ADVERTISED_LISTENERS: "PLAINTEXT://localhost:9092",
      KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
      KAFKA_CONTROLLER_QUORUM_VOTERS: "1@localhost:9093",
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
    },
    data: "/var/lib/kafka/data",
    templates: { KAFKA_BROKERS: "{host}:{port}" },
    description: "Apache Kafka in KRaft mode, without ZooKeeper.",
  },
  localstack: {
    image: "localstack/localstack:4.0.3",
    ports: [4566],
    health: ["CMD-SHELL", "curl -fs http://localhost:4566/_localstack/health > /dev/null"],
    credentials: { user: "test", password: "test" },
    data: "/var/lib/localstack",
    templates: { AWS_ENDPOINT_URL: "http://{host}:{port}", AWS_ACCESS_KEY_ID: "{user}", AWS_SECRET_ACCESS_KEY: "{password}", AWS_REGION: "us-east-1" },
    description: "LocalStack, local AWS services such as S3, SQS and DynamoDB.",
  },
  minio: {
    image: "minio/minio:RELEASE.2025-01-20T14-49-07Z",
    ports: [9000, 9001],
    // The check also creates the buckets listed in QS_BUCKETS, so a storage finds its bucket once the service is healthy.
    health: [
      "CMD-SHELL",
      'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" > /dev/null && for bucket in $QS_BUCKETS; do mc mb --ignore-existing "local/$bucket" > /dev/null || exit 1; done',
    ],
    credentials: { user: "minioadmin", password: "minioadmin" },
    environment: { MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
    command: ["server", "/data", "--console-address", ":9001"],
    data: "/data",
    templates: { S3_ENDPOINT: "http://{host}:{port}", S3_ACCESS_KEY_ID: "{user}", S3_SECRET_ACCESS_KEY: "{password}", S3_REGION: "us-east-1" },
    description: "MinIO, an S3-compatible object store.",
  },
  azurite: {
    image: "mcr.microsoft.com/azure-storage/azurite:3.33.0",
    ports: [10000, 10001, 10002],
    health: ["CMD-SHELL", "nc -z 127.0.0.1 10000"],
    credentials: { user: "devstoreaccount1", password: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==" },
    data: "/data",
    templates: {
      AZURE_STORAGE_CONNECTION_STRING:
        "DefaultEndpointsProtocol=http;AccountName={user};AccountKey={password};BlobEndpoint=http://{host}:{port:10000}/{user};QueueEndpoint=http://{host}:{port:10001}/{user};TableEndpoint=http://{host}:{port:10002}/{user};",
    },
    description: "Azurite, local Azure Blob, Queue and Table storage.",
  },
  vault: {
    image: "hashicorp/vault:1.18.3",
    ports: [8200],
    health: ["CMD-SHELL", "VAULT_ADDR=http://127.0.0.1:8200 vault status > /dev/null"],
    credentials: { password: "root" },
    environment: { VAULT_DEV_ROOT_TOKEN_ID: "root", VAULT_DEV_LISTEN_ADDRESS: "0.0.0.0:8200" },
    command: ["server", "-dev"],
    templates: { VAULT_ADDR: "http://{host}:{port}", VAULT_TOKEN: "{password}" },
    description: "HashiCorp Vault in development mode.",
  },
  keycloak: {
    image: "quay.io/keycloak/keycloak:26.0.7",
    ports: [8080, 9000],
    health: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q UP <&3"],
    credentials: { user: "admin", password: "admin" },
    environment: { KC_BOOTSTRAP_ADMIN_USERNAME: "admin", KC_BOOTSTRAP_ADMIN_PASSWORD: "admin", KC_HEALTH_ENABLED: "true" },
    command: ["start-dev"],
    templates: { OIDC_ISSUER: "http://{host}:{port}/realms/master" },
    description: "Keycloak identity provider in development mode.",
  },
  meilisearch: {
    image: "getmeili/meilisearch:v1.12.0",
    ports: [7700],
    health: ["CMD-SHELL", "curl -fs http://localhost:7700/health > /dev/null"],
    credentials: { password: "local-master-key" },
    environment: { MEILI_MASTER_KEY: "local-master-key", MEILI_ENV: "development" },
    data: "/meili_data",
    templates: { MEILISEARCH_URL: "http://{host}:{port}", MEILISEARCH_KEY: "{password}" },
    description: "Meilisearch search engine.",
  },
  typesense: {
    image: "typesense/typesense:27.1",
    ports: [8108],
    health: ["CMD-SHELL", "curl -fs http://localhost:8108/health > /dev/null"],
    credentials: { password: "local-api-key" },
    command: ["--data-dir", "/data", "--api-key", "local-api-key", "--enable-cors"],
    data: "/data",
    templates: { TYPESENSE_URL: "http://{host}:{port}", TYPESENSE_API_KEY: "{password}" },
    description: "Typesense search engine.",
  },
  opensearch: {
    image: "opensearchproject/opensearch:2.18.0",
    ports: [9200],
    health: ["CMD-SHELL", "curl -fs http://localhost:9200/_cluster/health > /dev/null"],
    credentials: {},
    environment: { "discovery.type": "single-node", DISABLE_SECURITY_PLUGIN: "true", OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m" },
    data: "/usr/share/opensearch/data",
    templates: { OPENSEARCH_URL: "http://{host}:{port}" },
    description: "OpenSearch search engine as a single node, without its security plugin.",
  },
  consul: {
    image: "hashicorp/consul:1.20.2",
    ports: [8500],
    health: ["CMD", "consul", "members"],
    credentials: {},
    command: ["agent", "-dev", "-client", "0.0.0.0"],
    templates: { CONSUL_HTTP_ADDR: "http://{host}:{port}" },
    description: "HashiCorp Consul in development mode.",
  },
  etcd: {
    image: "quay.io/coreos/etcd:v3.5.17",
    ports: [2379],
    health: ["CMD", "etcdctl", "endpoint", "health"],
    credentials: {},
    command: ["etcd", "--advertise-client-urls", "http://0.0.0.0:2379", "--listen-client-urls", "http://0.0.0.0:2379", "--data-dir", "/etcd-data"],
    data: "/etcd-data",
    templates: { ETCD_ENDPOINTS: "http://{host}:{port}" },
    description: "etcd key-value store.",
  },
  clamav: {
    image: "clamav/clamav:1.4.1",
    ports: [3310],
    health: ["CMD-SHELL", "clamdcheck.sh"],
    credentials: {},
    templates: { CLAMAV_URL: "tcp://{host}:{port}" },
    description: "ClamAV antivirus daemon.",
  },
  mailpit: {
    image: "axllent/mailpit:v1.21.8",
    ports: [1025, 8025],
    health: ["CMD", "/mailpit", "readyz"],
    credentials: {},
    templates: { SMTP_URL: "smtp://{host}:{port:1025}", MAILPIT_URL: "http://{host}:{port:8025}" },
    description: "Mailpit, a local SMTP server with a web inbox.",
  },
  "otel-collector": {
    image: "otel/opentelemetry-collector-contrib:0.116.1",
    ports: [4317, 4318, 13133],
    health: ["CMD", "/otelcol-contrib", "components"],
    credentials: {},
    templates: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://{host}:{port:4318}" },
    description: "OpenTelemetry Collector receiving OTLP over gRPC and HTTP.",
  },
  jaeger: {
    image: "jaegertracing/all-in-one:1.64.0",
    ports: [16686, 4317, 4318],
    health: ["CMD-SHELL", "wget -q -O /dev/null http://localhost:14269/"],
    credentials: {},
    environment: { COLLECTOR_OTLP_ENABLED: "true" },
    templates: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://{host}:{port:4318}", JAEGER_URL: "http://{host}:{port:16686}" },
    description: "Jaeger tracing with its UI and an OTLP receiver.",
  },
  ollama: {
    image: "ollama/ollama:0.5.4",
    ports: [11434],
    health: ["CMD", "ollama", "list"],
    credentials: {},
    data: "/root/.ollama",
    templates: { OLLAMA_URL: "http://{host}:{port}" },
    description: "Ollama, local language models.",
  },
};

/** Whether a text is a kind of the catalog. */
export function isInfraKind(kind: unknown): kind is InfraKind {
  return typeof kind === "string" && Object.hasOwn(INFRA_CATALOG, kind);
}

/** The problems of the catalog's entries: a missing image, an image tagged `latest` or without a tag, no ports or no health command. */
export function catalogProblems(catalog: Readonly<Record<string, InfraCatalogEntry>> = INFRA_CATALOG): string[] {
  const problems: string[] = [];
  for (const [kind, entry] of Object.entries(catalog)) {
    const tag = /:([^/:]+)$/.exec(entry.image ?? "")?.[1];
    if (!entry.image) problems.push(`${kind}: missing image`);
    else if (!tag) problems.push(`${kind}: ${entry.image} has no tag`);
    else if (tag === "latest") problems.push(`${kind}: ${entry.image} uses the tag latest; pin an exact version`);
    if (!entry.ports || entry.ports.length === 0) problems.push(`${kind}: missing ports`);
    if (!entry.health || entry.health.length < 2) problems.push(`${kind}: missing health command`);
  }
  return problems;
}
