export { CODES_BY_STATUS, HttpError, codeForStatus, toErrorResponse } from "./errors.ts";
export type { ErrorResponseOptions, FieldErrorDetail, HttpErrorOptions } from "./errors.ts";
export { alwaysHiddenPaths, CRUD_OPERATIONS, entityRoutePath, hiddenPathsFor, SYSTEM_FIELDS, vectorFields } from "./model.ts";
export type { ArrayOnDeleteAction, EnumDeclarationInfo, ParsedTag, ParsedTags, FileAccessMode, RelationKind, RelationSide, VectorMetric, VectorSettings, CrudOperation, EntityModel, Exposure, ReadOperation, HookReference, ModelIndex, OverrideHooksMode, FieldConstraints, FieldModel, FieldStorage, FieldType, NestedFieldModel, OnDeleteAction, PrimitiveFieldType, StringFormat, TypeDescriptor } from "./model.ts";
export { ReferenceArrayChange, validateBody } from "./validation.ts";
export type { ValidationMode, ValidationResult } from "./validation.ts";
export { DEFAULT_LIMIT, FILTER_OPERATORS, MAX_LIMIT, MAX_LIST_VALUES, convertQueryValue, listQueryFields, OPERATORS_BY_TYPE, parseListQuery, queryableFields, SIZE_COMPARISONS } from "./query.ts";
export type { Condition, FilterOperator, ListQuery, SizeComparison, SizeFilter, SortDirection, SortField } from "./query.ts";
export { UniqueViolationError } from "./adapter.ts";
export type { AdapterKind, Aggregate, AggregateValues, ConnectOptions, ReadColumns, DatabaseAdapter, FindManyOptions, FindManyResult, ReferencePull, RelatedScope, StoredRecord } from "./adapter.ts";
export { memoryAdapter } from "./adapters/memory.ts";
export { CONFIG_FILE, ConfigError, DEFAULT_PORT, DEFAULT_POPULATE_DEPTH, defineConfig, JOB_DEFAULTS, LIFECYCLE_DEFAULTS, loadConfig, resolveConfig, WORKERS_NEED_DATABASE_SERVER } from "./config.ts";
export { availableCpus, isPrimary, poolSizePerWorker, runPrimary, runsScheduledWork, runWorkers, SERVER_WORKERS_ENV, WORKER_INDEX_ENV, WORKERS_ENV, workerIndex } from "./workers.ts";
export type { PrimaryOptions, WorkerProcess } from "./workers.ts";
export type { ResolvedConfig, ServiceConfig } from "./config.ts";
export { createRepositories, createRepository, READ_METHODS, readRepository, repositoryFor } from "./repository.ts";
export type { EntityRecord, ListResult, Many, One, Populated, PopulatePath, ReadOptions, ReadRepository, ReferencePath, RelatedField, RelatedRecord, RelatedReferences, Repository, RepositoryOptions, RepositoryRegistry } from "./repository.ts";
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
export { createServer, toResponse } from "./http/server.ts";
export type { Endpoint, HandlerResult, Route, Server, ServerOptions } from "./http/server.ts";
export { Router, patternOf, splitPath } from "./http/router.ts";
export type { RouteMatch, RoutePattern } from "./http/router.ts";
export { executedHooks, operationForRoute, resolveRouteHooks, withHooks } from "./http/pipeline.ts";
export { AggregateExpression, aggregatesOf, conditionsOf, createQuery, QueryCondition, SortKey } from "./fluent-query.ts";
export type { AggregateExpressions, AggregateFields, AggregateResult, PageOptions, Query, QueryBackend, QueryFields, QueryLambda, SortFields, SortLambda } from "./fluent-query.ts";
export { parseQueryItems, withQueryItems } from "./http/query-items.ts";
export type { QueryItem, QueryItemLimits, QueryValueType } from "./http/query-items.ts";
export { DOCS_PATH, docsPage, docsRoutes, OPENAPI_PATH, SCALAR_URL, SCALAR_VERSION } from "./http/docs.ts";
export type { RouteHookSource } from "./http/pipeline.ts";
export { createCrudRoutes, mergeRoutes, populatePaths } from "./http/crud.ts";
export type { CrudOptions } from "./http/crud.ts";
export type { CrudRoute } from "./http/crud.ts";
export { createApp } from "./app.ts";
export { startService } from "./service.ts";
export { CORE_VERSION, generatedPath } from "./build-steps.ts";
export type { BuildFolderFile, FeatureBuildContext } from "./build-steps.ts";
export { defineCommand, isCommandDefinition } from "./commands.ts";
export type { CommandArg, CommandContext, CommandDefinition, CommandInput, CommandOutput } from "./commands.ts";
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
export { createFeatureLifecycle, featureLogger, LifecycleError, logLifecycleFailure, withTimeout } from "./lifecycle.ts";
export type { FeatureApp, FeatureLifecycle, FeatureLifecycleOptions, FeatureSetupContext, LifecyclePhase, RuntimeRoute, RuntimeRouteOptions, StartContext, WorkerInfo } from "./lifecycle.ts";
export type { App, AppEndpoint, AppOptions, CrudRouteEntry, FeatureFolderRegistry } from "./app.ts";
export { jsonLogger, safeLog } from "./logger.ts";
export { entityModel, field } from "./entity-model.ts";
export type { EntityModelOptions, FieldDefinition, FieldInput } from "./entity-model.ts";
export { deriveCollectionName, isValidCollectionName, pluralize, splitWords, toCamelCase, toSnakeCase } from "./naming.ts";
export type { LogEntry, Logger } from "./logger.ts";
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
export { DEFAULT_MAX_FILE_SIZE, mimeMatches, parseSize, sanitizeFilename } from "./files/limits.ts";
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
export type { FileAccess, FileAccessSettings } from "./files/access.ts";
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
} from "./features.ts";
export { prepareFeatureTargets, taggedRoutes, tagsOf } from "./feature-targets.ts";
export type { OptionsTarget, TaggedRoute } from "./feature-targets.ts";
export type { FeatureApi, FeatureApis, FeatureConfig, FeatureDefinition, FeatureDocs, FeatureEntities, FeatureBuild, FeatureEntitiesContext, FeatureFolder, FeatureInput, FeatureOpenApi, FeatureSetup, FeatureTag, FeatureTagTarget, TargetOptions, FeatureOptions, FeatureRequirement, NativeFeatures, ProjectFeatureModule, ResolvedFeature } from "./features.ts";
export { applyEnvironment, CONFIG_OVERRIDES, configVariable, envNameFor, featureVariables, logConfigWarnings, NOT_OVERRIDABLE, optionLeaves, overrideVariables, unknownVariableWarnings } from "./environment.ts";
export { maskSecrets, SECRET_MASK } from "./secrets.ts";
export type { ConfigOverride, EnvAlias, EnvironmentResult, OptionLeaf } from "./environment.ts";
export { runAfterHooks, runBeforeHooks } from "./feature-hooks.ts";
export { afterCommit, inTransaction, onRollback, runInTransaction, transaction } from "./transactions.ts";
export { changedFields, observeWrites } from "./write-observers.ts";
export type { WriteCause, WriteChange, WriteObserver } from "./write-observers.ts";
export { currentOperation, disableOperationContext, enableOperationContext, operationContextEnabled, operationMiddleware, withOperation } from "./operation-context.ts";
export type { OperationInfo } from "./operation-context.ts";
export type { AnyEvent, CustomEvent, EventActor, EventFor, EventMap, EventOf, PatternMatches, PayloadOf, WriteEvent, WriteOperation } from "./event-types.ts";
export { parseRate } from "./rates.ts";
export type { Rate } from "./rates.ts";
export { matchesCidr } from "./cidr.ts";
export { declaredVariables, env, readVariables, variableType } from "./env-vars.ts";
export type { DeclaredVariable, EnvVars } from "./env-vars.ts";
// The natives the core ships, registered when the core loads; they come last, after every export they use.
import eventsNative, { type EventsApi } from "./features/events/index.ts";
import securityNative, { type SecurityApi } from "./features/security/index.ts";
import { registerNative as registerShippedNative, type FeatureConfig as NativeConfig } from "./features.ts";
registerShippedNative(securityNative);
registerShippedNative(eventsNative);
export { addOutboxPatterns, events, eventsFeature, listen, memoryEventBus, readOutbox, tailOutbox } from "./features/events/index.ts";
export type { ConsumerOptions, DeliveryContext, DeliveryStatus, OutboxRecord } from "./features/events/index.ts";
export type { EventBus, EventListener, Events, EventsApi, ListenerContext, ListenerFile, ListenerPhase, ListenOptions, MemoryEventBus } from "./features/events/index.ts";
export { securityFeature } from "./features/security/index.ts";
export type { ExemptibleItem, SecurityApi } from "./features/security/index.ts";

declare module "./features.ts" {
  interface NativeFeatures {
    /** Write events for every entity, delivered to listeners; see the `events` reference page. */
    events?: NativeConfig<typeof eventsNative>;
    /** Safe defaults for every service, each item switchable; see the `security` reference page. */
    security?: NativeConfig<typeof securityNative>;
  }
  interface FeatureApis {
    events: EventsApi;
    security: SecurityApi;
  }
}
