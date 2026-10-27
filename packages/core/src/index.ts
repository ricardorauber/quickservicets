export { CODES_BY_STATUS, HttpError, codeForStatus, toErrorResponse } from "./errors.ts";
export type { ErrorResponseOptions, FieldErrorDetail, HttpErrorOptions } from "./errors.ts";
export { alwaysHiddenPaths, CRUD_OPERATIONS, entityRoutePath, hiddenPathsFor, SYSTEM_FIELDS, vectorFields } from "./model.ts";
export type { ArrayOnDeleteAction, EnumDeclarationInfo, ParsedTag, ParsedTags, FileAccessMode, RelationKind, RelationSide, VectorMetric, VectorSettings, CrudOperation, EntityModel, Exposure, ReadOperation, HookReference, ModelIndex, OverrideHooksMode, FieldConstraints, FieldModel, FieldStorage, FieldType, NestedFieldModel, OnDeleteAction, PrimitiveFieldType, StringFormat, TypeDescriptor } from "./model.ts";
export { ReferenceArrayChange, validateBody } from "./validation.ts";
export type { ValidationMode, ValidationResult } from "./validation.ts";
export { DEFAULT_LIMIT, FILTER_OPERATORS, MAX_LIMIT, MAX_LIST_VALUES, convertQueryValue, listQueryFields, OPERATORS_BY_TYPE, parseListQuery, queryableFields, SIZE_COMPARISONS } from "./query.ts";
export type { Condition, FilterOperator, ListQuery, SizeComparison, SizeFilter, SortDirection, SortField } from "./query.ts";
export { invalidConnection, UniqueViolationError } from "./adapter.ts";
export type { AdapterKind, Aggregate, AggregateValues, ConnectOptions, ReadColumns, DatabaseAdapter, FindManyOptions, FindManyResult, ReferencePull, RelatedScope, StoredRecord } from "./adapter.ts";
export { memoryAdapter } from "./adapters/memory.ts";
export { LEGACY_CONFIG_FILE, LEGACY_CONFIG_MESSAGE, LEGACY_MIGRATIONS_TABLE, MIGRATIONS_TABLE, MIGRATIONS_TABLE_RENAMED, renameLegacyMigrationTables } from "./legacy-names.ts";
export type { RenamedTable } from "./legacy-names.ts";
export { CONFIG_FILE, ConfigError, DEFAULT_PORT, DEFAULT_POPULATE_DEPTH, defineConfig, JOB_DEFAULTS, LIFECYCLE_DEFAULTS, loadConfig, resolveConfig, WORKERS_NEED_DATABASE_SERVER } from "./config.ts";
export { availableCpus, isPrimary, poolSizePerWorker, runPrimary, runsScheduledWork, runWorkers, SERVER_WORKERS_ENV, WORKER_INDEX_ENV, WORKERS_ENV, workerIndex } from "./workers.ts";
export type { PrimaryOptions, WorkerProcess } from "./workers.ts";
export type { ResolvedConfig, ServiceConfig } from "./config.ts";
export { configuredModels, configureRepositories, createRepositories, createRepository, READ_METHODS, readRepository, repositoriesFor, repositoryFor, repositoryLookup, repositoryPlans } from "./repository.ts";
export { configureRunRepositories, resolveRunRepositories, setRepositoryResolver } from "./repository-resolver.ts";
export { guardTenantRepositories, tenantRepositories, TenantRequiredError } from "./tenant-repositories.ts";
export { configureTenantRuns, runForTenant, setTenantRuns, tenantRuns } from "./tenant-runs.ts";
export type { RunTenant, TenantRunContext, TenantRuns } from "./tenant-runs.ts";
export { configureDatabaseScopes, currentDatabaseScope, currentTenant, databaseScopesEnabled, enableDatabaseScopes, scopedAdapter, scopeKeyOf, sharesConnection, systemTarget, withDatabaseScope } from "./database-scope.ts";
export type { DatabaseScope, DatabaseScopeInput, ScopeTenant } from "./database-scope.ts";
export type { RepositoryResolver, RepositoryResolverOptions, RunTarget } from "./repository-resolver.ts";
export type { EntityPlan, EntityRecord, ListResult, Many, One, Populated, PopulatePath, ReadOptions, ReadRepository, ReferencePath, RelatedField, RelatedRecord, RelatedReferences, Repository, RepositoryOptions, RepositoryRegistry, WriteOptions } from "./repository.ts";
export { etagOf, ifMatch, listedTags, noneMatch, preconditionFailed } from "./entity-tags.ts";
export { definePostHook, definePreHook, isHookDefinition, REQUEST_PROPERTIES } from "./hooks.ts";
export { composeHandlerStage, composeRequestStage, middlewareStages } from "./middleware.ts";
export type { ErrorMiddleware, ErrorStageContext, HandlerMiddleware, Middleware, MiddlewareStages, OwnedMiddleware, RequestMiddleware, RequestStageContext } from "./middleware.ts";
export type {
  HookCall,
  HookDefinition,
  HookDocs,
  HookOptions,
  HookPhase,
  PostHookFn,
  PreHookFn,
  Repositories,
  RequestExtensions,
  RequestFlags,
  RequestTenant,
  RequestUser,
  ServiceRequest,
  ServiceResponse,
} from "./hooks.ts";
export { createServer, deferRequestLog, peerAddress, toResponse, upgradeRequest } from "./http/server.ts";
export { defineSocket, isSocketDefinition, setSocketRunner, socketEndpoint } from "./http/socket.ts";
export type { Socket, SocketContext, SocketDefinition, SocketHandlers, SocketRunner } from "./http/socket.ts";
export { bodyPolicyOf, bodyTooLarge, bodyTooSlow, readBodyBytes, readBodyChunks, readBodyText, setBodyPolicy } from "./http/body.ts";
export type { BodyPolicy } from "./http/body.ts";
export type { EntityTags, Endpoint, FetchOptions, HandlerResult, Route, Server, ServerOptions, ServerSettings } from "./http/server.ts";
export { Router, patternOf, splitPath } from "./http/router.ts";
export type { RouteMatch, RoutePattern } from "./http/router.ts";
export { executedHooks, operationForRoute, resolveRouteHooks, withHooks } from "./http/pipeline.ts";
export { matchesConditions } from "./matching.ts";
export { reportError, reportFailure, reportStartupFailure, setErrorReportSink, setFailureSinks } from "./error-reports.ts";
export type { ErrorReport, ErrorReporter, ErrorReportKind, ErrorReportRequest, FailureDetails, ReportErrorExtra } from "./error-reports.ts";
export { observeJobRuns } from "./jobs/observers.ts";
export { contextFlags, setContextFlags } from "./context-flags.ts";
export { contextHttp, setContextHttp } from "./context-http.ts";
export type { ContextFlagEvaluator, FlagTarget } from "./context-flags.ts";
export type { ObservedJobRun } from "./jobs/observers.ts";
export { defineSse, isSseDefinition, setSseRunner, sseEndpoint } from "./http/sse.ts";
export type { SseDefinition, SseHandler, SseRunner, SseSendOptions, SseStream } from "./http/sse.ts";
export { AggregateExpression, aggregatesOf, conditionsOf, createQuery, QueryCondition, SortKey } from "./fluent-query.ts";
export type { AggregateExpressions, AggregateFields, AggregateResult, PageOptions, Query, QueryBackend, QueryFields, QueryLambda, SortFields, SortLambda } from "./fluent-query.ts";
export { parseQueryItems, withQueryItems } from "./http/query-items.ts";
export type { QueryItem, QueryItemLimits, QueryValueType } from "./http/query-items.ts";
export { DOCS_PATH, docsPage, docsRoutes, OPENAPI_PATH, SCALAR_URL, SCALAR_VERSION } from "./http/docs.ts";
export type { RouteHookSource } from "./http/pipeline.ts";
export { createCrudRoutes, mergeRoutes, populatePaths } from "./http/crud.ts";
export { rememberStoredRecord, storedRecordOf, trackStoredRecords } from "./http/stored-records.ts";
export { setWriteCondition, writeConditionOf } from "./http/write-conditions.ts";
export type { WriteCondition } from "./http/write-conditions.ts";
export type { StoredRecordOf } from "./http/stored-records.ts";
export type { CrudOptions } from "./http/crud.ts";
export type { CrudRoute } from "./http/crud.ts";
export { createApp } from "./app.ts";
export { startService } from "./service.ts";
export { CORE_VERSION, generatedPath } from "./build-steps.ts";
export type { BuildFolderFile, FeatureBuildContext } from "./build-steps.ts";
export { defineCommand, isCommandDefinition, jsonShapeProblems } from "./commands.ts";
export type { CommandArg, CommandContext, CommandDefinition, CommandInput, CommandOutput, JsonFields, JsonShape, PromptOptions } from "./commands.ts";
export { addOperation, addSchema, addSecurityScheme, extendOpenApi, requireSecurity } from "./openapi.ts";
export type {
  ApiKeySecurityScheme,
  FeatureOpenApiContext,
  HttpSecurityScheme,
  OAuth2SecurityScheme,
  OAuthScopes,
  OpenApiDoc,
  OpenIdConnectSecurityScheme,
  ProjectOpenApiContext,
  SecurityScheme,
} from "./openapi.ts";
export type { RunningService, StartServiceOptions } from "./service.ts";
export { createFeatureLifecycle, featureLogger, LifecycleError, logLifecycleFailure, notifyShutdownSignal, onServiceStarted, onShutdownSignal, withTimeout } from "./lifecycle.ts";
export type { FeatureApp, FeatureLifecycle, FeatureLifecycleOptions, FeatureSetupContext, LifecyclePhase, RuntimeRoute, RuntimeRouteOptions, StartContext, WorkerInfo } from "./lifecycle.ts";
export type { App, AppEndpoint, AppOptions, CrudRouteEntry, FeatureFolderRegistry } from "./app.ts";
export { jsonLogger, maskedLogger, REQUEST_LOG, safeLog } from "./logger.ts";
export { entityModel, field } from "./entity-model.ts";
export type { EntityModelOptions, FieldDefinition, FieldInput } from "./entity-model.ts";
export { deriveCollectionName, isValidCollectionName, pluralize, splitWords, toCamelCase, toSnakeCase } from "./naming.ts";
export type { LogEntry, LogMasker, Logger } from "./logger.ts";
export { buildDrizzleSchema, columnName, schemaIdentifier, SQLITE_DEFAULT_SCHEMA_TOKEN, sqliteDefaultPrefix } from "./sql/schema.ts";
export type { DrizzleSchema, DrizzleSchemaOptions, SqlDialect } from "./sql/schema.ts";
export { sqliteAdapter } from "./adapters/sqlite.ts";
export type { SqliteAdapter, SqliteAdapterOptions } from "./adapters/sqlite.ts";
export { escapeLike, toOrderBy, toWhere } from "./sql/conditions.ts";
export { postgresAdapter } from "./adapters/postgres.ts";
export type { PostgresAdapter, PostgresAdapterOptions } from "./adapters/postgres.ts";
export { mongodbAdapter, mongoIndexSpecs } from "./adapters/mongodb.ts";
export type { MongoIndexSpec, MongodbAdapter, MongodbAdapterOptions } from "./adapters/mongodb.ts";
export type { MigrationContext, MigrationSqlOptions, MongoMigrationContext } from "./migrations.ts";
export { parseFieldPaths, project, projectResult } from "./projection.ts";
export type { FieldPathsResult, Projection } from "./projection.ts";
export { isExposed, parseClientSelection, selectFields } from "./http/selection.ts";
export type { ClientSelection, SelectionContext } from "./http/selection.ts";
export { assertPopulatePaths, parsePopulateParam, populatePathErrors, populateRecords } from "./populate.ts";
export { builtInFileEntity, FILE_BASE_FIELDS, MEDIA_MIME_TYPES } from "./files.ts";
export type { File, FileBase, Media } from "./files.ts";
export { localStorage } from "./storage/local.ts";
export type { LocalStorageOptions } from "./storage/local.ts";
export { assertSafeKey, extensionOf, storageKeyFor, StorageKeyError } from "./storage/storage.ts";
export type { StorageAdapter, StorageBody } from "./storage/storage.ts";
export { s3Storage } from "./storage/s3.ts";
export type { S3StorageOptions } from "./storage/s3.ts";
export { DEFAULT_MAX_FILE_SIZE, formatSize, mimeMatches, parseSize, sanitizeFilename } from "./files/limits.ts";
export { assertFileAllowed, coerceFormValue, formFields, parseUpload, readMultipart, resolveUploadType, storageOf, storeFile } from "./files/upload.ts";
export { detectFileType } from "./files/detect.ts";
export type { ParsedUpload, UploadSettings } from "./files/upload.ts";
export {
  contentDisposition,
  fileAccessErrors,
  fileResponse,
  fileRoutePath,
  fileUrlOf,
  resolveFileAccess,
  signFile,
  verifyFileSignature,
  withFileUrls,
} from "./files/access.ts";
export type { FileAccess, FileAccessSettings, FileHeaders } from "./files/access.ts";
export { assertReferencedFilesAllowed, fileTargetOf } from "./files/field-limits.ts";
export { isMultipart, parseEntityUpload, withUploadedFiles } from "./files/references.ts";
export type { EntityUpload, UploadMode } from "./files/references.ts";
export { deleteObjects, isFileReferenced, objectOf, ownedFileFields, referencedIds } from "./files/cleanup.ts";
export type { FileCleanupSettings, StoredObject } from "./files/cleanup.ts";
export { DURATION_UNITS, isJobDefinition, job, jobSettings, parseDuration } from "./jobs/job.ts";
export { assertTimeZone, DEFAULT_TIME_ZONE, nextRunTime, parseCron, parseDate, parseInterval, parseSchedule, ScheduleError } from "./jobs/schedule.ts";
export type { CronSchedule, DateSchedule, IntervalSchedule, ParsedSchedule, Schedule } from "./jobs/schedule.ts";
export type { JobContext, JobDefinition, JobFn, JobLogFields, JobLogger, JobOptions, JobRunInfo, JobSchedule, JobSettings, JobTrigger } from "./jobs/job.ts";
export { JOB_LOG_LEVELS, JOB_RUN_STATUSES, JOB_TRIGGERS, jobRunEntity } from "./jobs/job-run.ts";
export type { JobRun, JobRunLog, JobRunStatus } from "./jobs/job-run.ts";
export { ABANDONED_CHECK_INTERVAL, createAbandonedRunMonitor, handleShutdownSignals, heartbeatInterval } from "./jobs/lifecycle.ts";
export type { AbandonedRunMonitor, AbandonedRunMonitorOptions, SignalTarget } from "./jobs/lifecycle.ts";
export { createJobRunner, createJobScheduler, createLogCollector, MAX_TIMER_DELAY, runError, storableResult, systemClock } from "./jobs/scheduler.ts";
export type { ActiveRun, JobClock, JobRunner, JobRunnerOptions, JobScheduler, JobSchedulerOptions, RunRequest } from "./jobs/scheduler.ts";
export { createRequestJobs, noRequestJobs, runOnDemand } from "./jobs/triggers.ts";
export { createJobRunCleanup, RUN_CLEANUP_BATCH, RUN_CLEANUP_INTERVAL } from "./jobs/retention.ts";
export type { JobRunCleanup, JobRunCleanupOptions } from "./jobs/retention.ts";
export type { JobName, JobNames, OnDemandRequest, RequestJobs, RunJobOptions } from "./jobs/triggers.ts";
export {
  anyOf,
  boolean,
  describeOptions,
  duration,
  expectationOf,
  integer,
  list,
  number,
  object,
  oneOf,
  OptionError,
  optionTypeOf,
  closestName,
  suggestion,
  parseOptionString,
  provider,
  hook,
  rate,
  record,
  cidr,
  toggle,
  resolveOption,
  resolveOptions,
  secret,
  size,
  string,
  url,
} from "./options.ts";
export type {
  AnyOptionSchema,
  BaseOptionSchema,
  BoundedOptionSchema,
  ListOptionSchema,
  ObjectOptionSchema,
  RecordOptionSchema,
  ToggleOptionSchema,
  FeatureHook,
  HookOptionSchema,
  OptionContext,
  OptionDescription,
  OptionFunction,
  OptionKind,
  Options,
  OptionSchema,
  OptionSettings,
  OptionsInput,
  SecretOptionSchema,
  UrlOptionSchema,
} from "./options.ts";
export {
  BUILT_IN_CONFIG_KEYS,
  defineFeature,
  assertFeatureFolders,
  FEATURES_DIR,
  featureDir,
  RESERVED_FOLDERS,
  isFeatureDefinition,
  NATIVE_FEATURES_DIR,
  loadProjectFeatures,
  logEnabledFeatures,
  projectFeatureFolders,
  registeredNatives,
  registeredProjectFeatures,
  registerNative,
  registerProjectFeatures,
  replacedNatives,
  activeFeatureDefinitions,
  resolveFeatures,
  scopedOptionSchema,
  hookOptionNames,
  lastResolvedFeatures,
} from "./features.ts";
export { prepareFeatureTargets, runtimeTargets, taggedRoutes, tagsOf } from "./feature-targets.ts";
export type { OptionsTarget, RuntimeTarget, TaggedRoute } from "./feature-targets.ts";
export type { FeatureApi, FeatureApis, FeatureConfig, FeatureDefinition, FeatureDocs, FeatureEntities, FeatureBuild, FeatureEntitiesContext, FeatureFolder, FeatureInput, FeatureOpenApi, FeatureSetup, FeatureTag, FeatureTagTarget, TargetOptions, FeatureOptions, FeatureRequirement, NativeFeatures, ProjectFeatureModule, ResolvedFeature } from "./features.ts";
export { applyEnvironment, CONFIG_OVERRIDES, configVariable, envNameFor, featureVariables, logConfigWarnings, NOT_OVERRIDABLE, optionLeaves, overrideVariables, unknownVariableWarnings } from "./environment.ts";
export { maskSecrets, SECRET_MASK } from "./secrets.ts";
export type { ConfigOverride, EnvAlias, EnvironmentResult, OptionLeaf } from "./environment.ts";
export { runAfterHooks, runBeforeHooks } from "./feature-hooks.ts";
export { afterCommit, assertWritable, currentTransaction, inTransaction, onRollback, runInTransaction, transaction } from "./transactions.ts";
export { changedFields, observeWrites } from "./write-observers.ts";
export type { WriteCause, WriteChange, WriteObserver } from "./write-observers.ts";
export { currentOperation, disableOperationContext, enableOperationContext, operationContextEnabled, operationMiddleware, withOperation } from "./operation-context.ts";
export type { OperationInfo } from "./operation-context.ts";
export type { AnyEvent, CustomEvent, EventActor, EventFor, EventMap, EventOf, PatternMatches, PayloadOf, WriteEvent, WriteOperation } from "./event-types.ts";
export { parseRate } from "./rates.ts";
export type { Rate } from "./rates.ts";
export { cidrMatcher, matchesCidr, normalizeAddress } from "./cidr.ts";
export { cookieValue, sessionCookie } from "./cookies.ts";
export { normalizeOrigin, OriginMatcher, ownOriginReader } from "./origins.ts";
export type { SessionCookieOptions } from "./cookies.ts";
export { declaredVariables, env, readVariables, secretVariableValues, variableType } from "./env-vars.ts";
export type { DeclaredVariable, EnvVars } from "./env-vars.ts";
// The natives the core ships, registered when the core loads; they come last, after every export they use.
import eventsNative, { type EventsApi } from "./features/events/index.ts";
import securityNative, { type SecurityApi } from "./features/security/index.ts";
import etagNative from "./features/etag/index.ts";
import historyNative, { type HistoryApi } from "./features/history/index.ts";
import realtimeNative, { type RealtimeApi } from "./features/realtime/index.ts";
import errorsNative, { type ErrorsApi } from "./features/errors/index.ts";
import flagsNative, { type FlagsApi } from "./features/flags/index.ts";
import idempotencyNative, { type IdempotencyApi } from "./features/idempotency/index.ts";
import healthNative, { type HealthApi, type HealthStatusChangedEvent } from "./features/health/index.ts";
import queuesNative, { type QueueClient, type QueueMessageEvent, type QueuesApi } from "./features/queues/index.ts";
import httpNative, { type Http, type HttpApi } from "./features/http/index.ts";
import tenancyNative, { type TenancyApi } from "./features/tenancy/index.ts";
import authNative, { type AuthApi, type RequestAuth, type SessionRevokedEvent } from "./features/auth/index.ts";
import { registerNative as registerShippedNative, type FeatureConfig as NativeConfig } from "./features.ts";
registerShippedNative(securityNative);
registerShippedNative(eventsNative);
registerShippedNative(queuesNative);
registerShippedNative(healthNative);
registerShippedNative(idempotencyNative);
registerShippedNative(etagNative);
registerShippedNative(historyNative);
registerShippedNative(realtimeNative);
registerShippedNative(errorsNative);
registerShippedNative(flagsNative);
registerShippedNative(httpNative);
registerShippedNative(tenancyNative);
registerShippedNative(authNative);
export {
  addAuthScheme,
  AuthError,
  authFeature,
  dummyPasswordCheck,
  identifierHash,
  invalidCredentials,
  loginGuard,
  memoryThrottleStore,
  NO_AUTH_SCHEME_WARNING,
  repositoryThrottleStore,
  requireRole,
  requireUser,
  sessionStore,
  ThrottleConflictError,
  tokenHashOf,
  tooManyAttempts,
} from "./features/auth/index.ts";
export type { LoginCheck, LoginGuard, LoginGuardOptions, LoginThrottleRecord, LoginThrottleStore, SessionRevokedEvent, SessionStore, SessionStoreOptions, StoredSession } from "./features/auth/index.ts";
export type { AuthApi, AuthCredentials, AuthenticatedUser, AuthMethod, AuthProvider, AuthResult, AuthResultUser, RequestAuth, RevokeTarget } from "./features/auth/index.ts";
export { addOutboxPatterns, events, eventsFeature, listen, memoryEventBus, readOutbox, tailOutbox } from "./features/events/index.ts";
export type { ConsumerOptions, DeliveryContext, DeliveryStatus, OutboxRecord } from "./features/events/index.ts";
export type { EventBus, EventListener, Events, EventsApi, ListenerContext, ListenerFile, ListenerPhase, ListenOptions, MemoryEventBus } from "./features/events/index.ts";
export { DEFAULT_MASKED_KEYS, maskEntry, maskText, maskUrl, memoryRateLimitStore, securityFeature, slidingWindowHit } from "./features/security/index.ts";
export type { ClientIpResolver, ExemptibleItem, MaskingRules, MemoryRateLimitStore, RateLimitRefusal, SecurityRefusal, RateLimitHit, RateLimitResult, RateLimitStore, SecurityApi, WindowCounts } from "./features/security/index.ts";

export { databaseBroker, isQueueDefinition, QUEUE_MESSAGE_STATUSES, queue, queueMessageEntity, queues, queuesFeature } from "./features/queues/index.ts";
export type {
  QueueDeadMessage,
  QueueEnqueueContext,
  QueueEnqueued,
  QueueEnqueueStep,
  QueueMessageEvent,
  QueueOutcomeReport,
  QueueProcessed,
  QueueProcessStep,
  DatabaseBroker,
  DatabaseBrokerOptions,
  QueueAddOptions,
  QueueAddResult,
  QueueBroker,
  QueueBrokerContext,
  QueueBrokerMessage,
  QueueClient,
  QueueContext,
  QueueDefinition,
  QueueMessage,
  QueueMessageInfo,
  QueueMessageStatus,
  QueueName,
  QueueOptions,
  QueueOutcome,
  QueuePayloadOf,
  QueuePayloads,
  QueueReceivedMessage,
  Queues,
  QueueSettings,
  QueuesApi,
  QueueStats,
} from "./features/queues/index.ts";

export { healthFeature, runHealthChecks } from "./features/health/index.ts";
export type {
  HealthApi,
  HealthCheck,
  HealthCheckDone,
  HealthCheckEntry,
  HealthCheckFunction,
  HealthCheckInput,
  HealthCheckOptions,
  HealthCheckResult,
  HealthCheckStep,
  HealthProber,
  HealthReport,
  HealthStatus,
  HealthStatusChange,
  HealthStatusChangedEvent,
} from "./features/health/index.ts";

export { idempotencyFeature, idempotencyKeyEntity } from "./features/idempotency/index.ts";
export type { BeginResult, IdempotencyApi, IdempotencyConflict, IdempotencyRecord, IdempotencyStep, IdempotencyStore, StoredResponse } from "./features/idempotency/index.ts";

export { etagFeature } from "./features/etag/index.ts";
export type { EntityTagger, NotModified, PreconditionFailure } from "./features/etag/index.ts";

export { historyFeature } from "./features/history/index.ts";
export { realtimeFeature } from "./features/realtime/index.ts";
export type { ChangeDelivery, ChangeSend, ChangeSource, RealtimeApi } from "./features/realtime/index.ts";
export { consoleReporter, errorsFeature, setSamplingRandom } from "./features/errors/index.ts";
export type { ErrorsApi } from "./features/errors/index.ts";
export { defineModifier, http, HttpClientError, httpFeature, HttpRequestBuilder, withBulkhead, withCache, withCircuitBreaker, withRetry } from "./features/http/index.ts";
export type { HttpTransport, HttpMock, MockCall, MockHandler, MockReply, MockRequest, MockService, BulkheadOptions, CacheOptions, CircuitBreakerOptions, HttpState, ModifierFunction, RetryOptions, Http, HttpApi, HttpBody, HttpClientErrorCode, HttpClientErrorInit, HttpMethods, HttpServiceMethods, HttpServiceNames, ServiceName, ServiceOptions, ServiceOptionsInput, HttpModifier, HttpQueryValue, HttpRequest, HttpResponse } from "./features/http/index.ts";
export { bucketOf, evaluateRule, flagsFeature } from "./features/flags/index.ts";
export { appliedTenantMigrations, migrateTenant, migrateTenantDatabase, migrationFiles, MONGO_MIGRATIONS_COLLECTION, provisionTenant, strategyOf, tenancyOptionsOf, tenantOperations } from "./features/tenancy/index.ts";
export type { TenancyOptions, TenantOperations, TenantProvisionResult } from "./features/tenancy/index.ts";
export { crossTenancyReferences, maskConnections, markTenancy, SHARED_ENTITY_KEYS, tenantPools, withoutTenancyMarks } from "./features/tenancy/index.ts";
export type { PoolCloseReason, PoolLease, PoolSettings, PoolStats, TenantPool, TenantPools } from "./features/tenancy/index.ts";
export { cachedDirectory, compilePathPattern, configDirectory, databaseDirectory, directoryClock, matchPathPrefix, serviceDirectory, subdomainOf, TENANT_FIELDS, TENANT_ID, TENANT_SOURCES, tenancyFeature, tenantEntity, tenantInfoOf } from "./features/tenancy/index.ts";
export type { CachedDirectory, DirectoryCacheOptions, TenancyApi, TenantDirectory, TenantInfo, TenantSource } from "./features/tenancy/index.ts";
export type { FlagContext, FlagEvaluation, FlagProvider, FlagProviderContext, FlagReason, FlagResult, FlagRule, FlagRuleFunction, FlagsApi, FlagSubject, RequestFlagEvaluator } from "./features/flags/index.ts";
export type {
  DatabaseHistoryStore,
  HistoryApi,
  HistoryCoverage,
  HistoryOperation,
  HistoryRetentionFunction,
  HistoryStore,
  HistoryVersion,
  HistoryVersionStep,
  HistoryWrittenVersion,
  NewVersion,
  VersionPage,
  VersionQuery,
} from "./features/history/index.ts";

declare module "./event-types.ts" {
  interface EventMap {
    /** A queue message completed; emitted by the `queues` native while `events` is enabled. */
    "queue.message.completed": QueueMessageEvent;
    /** An attempt of a queue message failed. */
    "queue.message.failed": QueueMessageEvent;
    /** A queue message used its last attempt. */
    "queue.message.dead": QueueMessageEvent;
    /** A session, or every session of a user, was revoked; emitted by the `auth` native per provider while `events` is enabled. */
    "auth.session.revoked": SessionRevokedEvent;
    /** The overall readiness of a worker changed; emitted by the `health` native while `events` is enabled. */
    "health.status.changed": HealthStatusChangedEvent;
  }
}

declare module "./hooks.ts" {
  interface RequestExtensions {
    /** Adds messages to the project's queues, carrying the request's id; present while the `queues` native is enabled. */
    queue: QueueClient;
    /**
     * The outgoing HTTP client bound to the request: every call sends the request's id as `x-request-id`, and calls
     * through services propagate what they ask for; present while the `http` native is enabled.
     */
    http: Http;
    /** The `Last-Event-ID` header, or the `lastEventId` query parameter without it; present while the `realtime` native is enabled. */
    lastEventId: string | undefined;
    /**
     * How the request authenticated (the provider, the method, the session, the expiry and the scopes), or undefined for
     * an anonymous request; present while the `auth` native is enabled.
     */
    auth: RequestAuth | undefined;
  }
}

declare module "./features.ts" {
  interface NativeFeatures {
    /** Write events for every entity, delivered to listeners; see the `events` reference page. */
    events?: NativeConfig<typeof eventsNative>;
    /** Safe defaults for every service, each item switchable; see the `security` reference page. */
    security?: NativeConfig<typeof securityNative>;
    /** Background queues in the project's database; see the `queues` reference page. */
    queues?: NativeConfig<typeof queuesNative>;
    /** Liveness and readiness routes; see the `health` reference page. */
    health?: NativeConfig<typeof healthNative>;
    /** Idempotency keys for safe retries; see the `idempotency` reference page. */
    idempotency?: NativeConfig<typeof idempotencyNative>;
    /** Entity tags and conditional requests; see the `etag` reference page. */
    etag?: NativeConfig<typeof etagNative>;
    /** Versions of the records of chosen entities; see the `history` reference page. */
    history?: NativeConfig<typeof historyNative>;
    /** Server-Sent Events endpoints; see the `realtime` reference page. */
    realtime?: NativeConfig<typeof realtimeNative>;
    /** Error reports to a reporting service; see the `errors` reference page. */
    errors?: NativeConfig<typeof errorsNative>;
    /** Feature flags per user, tenant or percentage; see the `flags` reference page. */
    flags?: NativeConfig<typeof flagsNative>;
    /** The outgoing HTTP client, enabled by default; see the `http` reference page. */
    http?: NativeConfig<typeof httpNative>;
    /** Multi-tenancy: the tenant of every request; see the `tenancy` reference page. */
    tenancy?: NativeConfig<typeof tenancyNative>;
    /** One authentication contract for every provider; see the `auth` reference page. */
    auth?: NativeConfig<typeof authNative>;
  }
  interface FeatureApis {
    events: EventsApi;
    queues: QueuesApi;
    health: HealthApi;
    idempotency: IdempotencyApi;
    security: SecurityApi;
    history: HistoryApi;
    realtime: RealtimeApi;
    errors: ErrorsApi;
    flags: FlagsApi;
    http: HttpApi;
    tenancy: TenancyApi;
    auth: AuthApi;
  }
}

declare module "./hooks.ts" {
  interface RequestTenant {
    /** The tenant's id, set by the `tenancy` native (or an authentication provider). */
    id: string;
    /** The tenant's plan from the tenant directory. */
    plan?: string;
    /** The texts the tenant carries in the tenant directory. */
    attributes: Record<string, string>;
  }
}

declare module "./hooks.ts" {
  interface RequestUser {
    /** The user's id, set by an authentication provider through the `auth` native. */
    id: string;
    /** The user's roles; the `auth` native sets an empty list when the provider gives none. */
    roles?: string[];
    email?: string;
    name?: string;
    /** Any other claims of the credentials; the `auth` native sets an empty object when the provider gives none. */
    claims?: Record<string, unknown>;
  }
}
