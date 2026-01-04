import type { MaybePromise } from '@nmtjs/common'
import type { TProcedureContract, TRouterContract } from '@nmtjs/contract'
import type { Dependencies, DependencyContext, Metadata } from '@nmtjs/core'
import type { NullableType, OptionalType } from '@nmtjs/type'
import type { NeverType } from '@nmtjs/type/never'
import { CoreInjectables } from '@nmtjs/core'
import { t } from '@nmtjs/type'

import type { AnyGuard } from '../application/api/guards.ts'
import type { AnyMiddleware } from '../application/api/middlewares.ts'
import type { AnyProcedure } from '../application/api/procedure.ts'
import type { AnyRouter, Router } from '../application/api/router.ts'
import type { AnyJob } from './job.ts'
import type { JobStatus } from './types.ts'
import { createProcedure } from '../application/api/procedure.ts'
import { createRouter } from '../application/api/router.ts'
import { jobManager } from '../injectables.ts'

// ============================================================================
// Configuration Types
// ============================================================================

/** Base operation config shared by all operations */
export type BaseOperationConfig<Deps extends Dependencies = {}> = {
  dependencies?: Deps
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  metadata?: Metadata[]
  timeout?: number
}

/** List operation config (read-only, no hooks) */
export type ListOperationConfig<Deps extends Dependencies = {}> =
  BaseOperationConfig<Deps>

/** Get operation config (read-only, no hooks) */
export type GetOperationConfig<Deps extends Dependencies = {}> =
  BaseOperationConfig<Deps>

/** Info operation config (read-only, no hooks) */
export type InfoOperationConfig<Deps extends Dependencies = {}> =
  BaseOperationConfig<Deps>

/** Add queue options */
export type AddQueueOptions = {
  priority?: number
  attempts?: number
  delay?: number
}

/** Add operation config with before/after hooks */
export type AddOperationConfig<
  T extends AnyJob = AnyJob,
  Deps extends Dependencies = {},
> = BaseOperationConfig<Deps> & {
  beforeAdd?: (
    ctx: DependencyContext<Deps>,
    input: T['_']['input'],
  ) => MaybePromise<T['_']['input']>
  afterAdd?: (
    ctx: DependencyContext<Deps>,
    result: { id: string; name: string },
    input: T['_']['input'],
  ) => MaybePromise<void>
  options?: AddQueueOptions
}

/** Remove operation config with before/after hooks */
export type RemoveOperationConfig<Deps extends Dependencies = {}> =
  BaseOperationConfig<Deps> & {
    beforeRemove?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
    afterRemove?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
  }

/** Retry operation config with before/after hooks */
export type RetryOperationConfig<Deps extends Dependencies = {}> =
  BaseOperationConfig<Deps> & {
    clearState?: boolean
    beforeRetry?: (
      ctx: DependencyContext<Deps>,
      params: { id: string; clearState?: boolean },
    ) => MaybePromise<void>
    afterRetry?: (
      ctx: DependencyContext<Deps>,
      params: { id: string; clearState?: boolean },
    ) => MaybePromise<void>
  }

/** Cancel operation config with before/after hooks */
export type CancelOperationConfig<Deps extends Dependencies = {}> =
  BaseOperationConfig<Deps> & {
    beforeCancel?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
    afterCancel?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
  }

/** All operations for a job (false = disabled) */
export type JobOperations<T extends AnyJob = AnyJob> = {
  info?: InfoOperationConfig<any> | false
  list?: ListOperationConfig<any> | false
  get?: GetOperationConfig<any> | false
  add?: AddOperationConfig<T, any> | false
  retry?: RetryOperationConfig<any> | false
  cancel?: CancelOperationConfig<any> | false
  remove?: RemoveOperationConfig<any> | false
}

/** Default operations config */
export type DefaultOperations = {
  info?: InfoOperationConfig<any> | false
  list?: ListOperationConfig<any> | false
  get?: GetOperationConfig<any> | false
  add?: AddOperationConfig<AnyJob, any> | false
  retry?: RetryOperationConfig<any> | false
  cancel?: CancelOperationConfig<any> | false
  remove?: RemoveOperationConfig<any> | false
}

/** Options for createJobsRouter */
export type CreateJobsRouterOptions<Jobs extends Record<string, AnyJob>> = {
  jobs: Jobs
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  defaults?: DefaultOperations
  overrides?: {
    [K in keyof Jobs]?: JobOperations<Jobs[K]>
  }
}

// ============================================================================
// Router Contract Types
// ============================================================================

/** Type-level schema for JobProgressCheckpoint - typed per job */
type JobProgressCheckpointSchemaType<T extends AnyJob> = t.ObjectType<{
  stepIndex: t.NumberType
  stepLabel: OptionalType<t.StringType>
  result: t.RecordType<t.StringType, t.AnyType>
  stepResults: t.ArrayType<
    NullableType<
      t.ObjectType<{
        data: NullableType<t.RecordType<t.StringType, t.AnyType>>
        duration: t.NumberType
      }>
    >
  >
  progress: T['progress']
}>

/** Type-level representation of createJobItemSchema output */
type JobItemSchemaType<T extends AnyJob> = t.ObjectType<{
  id: t.StringType
  name: t.StringType
  queue: t.StringType
  data: T['input']
  output: OptionalType<NullableType<T['output']>>
  status: t.StringType
  priority: OptionalType<t.NumberType>
  progress: OptionalType<JobProgressCheckpointSchemaType<T>>
  attempts: t.NumberType
  startedAt: OptionalType<t.NumberType>
  completedAt: OptionalType<t.NumberType>
  error: OptionalType<t.StringType>
  stacktrace: OptionalType<t.ArrayType<t.StringType>>
}>

/** Type-level representation of createListOutputSchema output */
type ListOutputSchemaType<T extends AnyJob> = t.ObjectType<{
  items: t.ArrayType<JobItemSchemaType<T>>
  page: t.NumberType
  limit: t.NumberType
  pages: t.NumberType
  total: t.NumberType
}>

/** Type-level representation of createGetOutputSchema output */
type GetOutputSchemaType<T extends AnyJob> = NullableType<JobItemSchemaType<T>>

/** Type-level representation of infoOutputSchema */
type InfoOutputSchemaType = typeof infoOutputSchema

/** Type-level representation of createAddInputSchema output */
type AddInputSchemaType<T extends AnyJob> = t.ObjectType<{
  data: T['input']
  jobId: OptionalType<t.StringType>
  priority: OptionalType<t.NumberType>
  delay: OptionalType<t.NumberType>
}>

/** Operations contract for a single job - now properly typed per job */
type JobOperationsProcedures<T extends AnyJob> = {
  info: TProcedureContract<NeverType, InfoOutputSchemaType>
  list: TProcedureContract<typeof listInputSchema, ListOutputSchemaType<T>>
  get: TProcedureContract<typeof getInputSchema, GetOutputSchemaType<T>>
  add: TProcedureContract<AddInputSchemaType<T>, typeof addOutputSchema>
  retry: TProcedureContract<typeof retryInputSchema, NeverType>
  cancel: TProcedureContract<typeof idInputSchema, NeverType>
  remove: TProcedureContract<typeof idInputSchema, NeverType>
}

/** Router contract for a single job's operations */
type JobRouterContract<T extends AnyJob> = TRouterContract<
  JobOperationsProcedures<T>
>

/** Full jobs router contract mapping job names to their operation routers */
type JobsRouterContract<Jobs extends Record<string, AnyJob>> = TRouterContract<{
  [K in keyof Jobs]: JobRouterContract<Jobs[K]>
}>

/** Return type for createJobsRouter */
export type JobsRouter<Jobs extends Record<string, AnyJob>> = Router<
  JobsRouterContract<Jobs>
>

// ============================================================================
// Schemas
// ============================================================================

/** Input schema for list operation */
const listInputSchema = t.object({
  page: t.number().optional(),
  limit: t.number().optional(),
  status: t.array(t.string()).optional(),
})

/** Input schema for get operation */
const getInputSchema = t.object({ id: t.string() })

/** Output schema for add operation */
const addOutputSchema = t.object({ id: t.string(), name: t.string() })

/** Input schema for retry operation */
const retryInputSchema = t.object({
  id: t.string(),
  clearState: t.boolean().optional(),
})

/** Input schema for cancel/remove operations */
const idInputSchema = t.object({ id: t.string() })

/** Output schema for info operation */
const infoOutputSchema = t.object({
  name: t.string(),
  steps: t.array(
    t.object({ label: t.string().optional(), conditional: t.boolean() }),
  ),
})

/** Schema for step result entry */
const stepResultEntrySchema = t
  .object({
    data: t.record(t.string(), t.any()).nullable(),
    startedAt: t.number(),
    completedAt: t.number(),
    duration: t.number(),
  })
  .nullable()

/** Creates JobProgressCheckpoint schema for a specific job */
function createJobProgressCheckpointSchema<T extends AnyJob>(
  job: T,
): JobProgressCheckpointSchemaType<T> {
  return t.object({
    stepIndex: t.number(),
    stepLabel: t.string().optional(),
    result: t.record(t.string(), t.any()),
    stepResults: t.array(stepResultEntrySchema),
    progress: job.progress,
  })
}

/** JobItem schema for list/get responses - typed per job */
function createJobItemSchema<T extends AnyJob>(job: T): JobItemSchemaType<T> {
  return t.object({
    id: t.string(),
    name: t.string(),
    queue: t.string(),
    data: job.input,
    output: job.output.nullish(),
    status: t.string(),
    priority: t.number().optional(),
    progress: createJobProgressCheckpointSchema(job).optional(),
    attempts: t.number(),
    startedAt: t.number().optional(),
    completedAt: t.number().optional(),
    error: t.string().optional(),
    stacktrace: t.array(t.string()).optional(),
  })
}

/** Creates list output schema for a specific job */
function createListOutputSchema<T extends AnyJob>(
  job: T,
): ListOutputSchemaType<T> {
  return t.object({
    items: t.array(createJobItemSchema(job)),
    page: t.number(),
    limit: t.number(),
    pages: t.number(),
    total: t.number(),
  })
}

/** Creates get output schema for a specific job */
function createGetOutputSchema<T extends AnyJob>(
  job: T,
): GetOutputSchemaType<T> {
  return createJobItemSchema(job).nullable()
}

/** Creates add input schema for a specific job */
function createAddInputSchema<T extends AnyJob>(job: T): AddInputSchemaType<T> {
  return t.object({
    data: job.input,
    jobId: t.string().optional(),
    priority: t.number().optional(),
    delay: t.number().optional(),
  })
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Helper function to create a type-safe operation config with dependencies.
 * Use this when you need custom dependencies for hooks.
 *
 * @example
 * ```ts
 * add: jobOperation({
 *   dependencies: { userService, auditLog },
 *   beforeAdd: async (ctx, input) => {
 *     return { ...input, createdBy: ctx.userService.getCurrentId() }
 *   },
 * })
 * ```
 */
export function jobOperation<
  Deps extends Dependencies,
  T extends AnyJob = AnyJob,
>(
  config: BaseOperationConfig<Deps> & {
    // Add hooks
    beforeAdd?: (
      ctx: DependencyContext<Deps>,
      input: T['_']['input'],
    ) => MaybePromise<T['_']['input']>
    afterAdd?: (
      ctx: DependencyContext<Deps>,
      result: { id: string; name: string },
      input: T['_']['input'],
    ) => MaybePromise<void>
    options?: AddQueueOptions

    // Remove hooks
    beforeRemove?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
    afterRemove?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>

    // Retry hooks
    clearState?: boolean
    beforeRetry?: (
      ctx: DependencyContext<Deps>,
      params: { id: string; clearState?: boolean },
    ) => MaybePromise<void>
    afterRetry?: (
      ctx: DependencyContext<Deps>,
      params: { id: string; clearState?: boolean },
    ) => MaybePromise<void>

    // Cancel hooks
    beforeCancel?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
    afterCancel?: (
      ctx: DependencyContext<Deps>,
      params: { id: string },
    ) => MaybePromise<void>
  },
): typeof config {
  return config
}

// ============================================================================
// Implementation
// ============================================================================

type JobManagerDeps = {
  jobManager: typeof jobManager
  logger: typeof CoreInjectables.logger
}

function createInfoProcedure(
  job: AnyJob,
  config: InfoOperationConfig<any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    output: infoOutputSchema,
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: (ctx: DependencyContext<JobManagerDeps>) => {
      ctx.logger.trace({ jobName: job.options.name }, 'Getting job info')
      return ctx.jobManager.getInfo(job)
    },
  })
}

function createListProcedure(
  job: AnyJob,
  config: ListOperationConfig<any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    input: listInputSchema,
    output: createListOutputSchema(job),
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: async (ctx: DependencyContext<JobManagerDeps>, input) => {
      ctx.logger.debug(
        {
          jobName: job.options.name,
          page: input.page,
          limit: input.limit,
          status: input.status,
        },
        'Listing jobs',
      )
      const result = await ctx.jobManager.list(job, {
        page: input.page,
        limit: input.limit,
        status: input.status as JobStatus[],
      })
      ctx.logger.debug(
        { jobName: job.options.name, total: result.total, pages: result.pages },
        'Jobs listed',
      )
      return result
    },
  })
}

function createGetProcedure(
  job: AnyJob,
  config: GetOperationConfig<any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    input: getInputSchema,
    output: createGetOutputSchema(job),
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: async (ctx: DependencyContext<JobManagerDeps>, input) => {
      ctx.logger.trace(
        { jobName: job.options.name, id: input.id },
        'Getting job',
      )
      const result = await ctx.jobManager.get(job, input.id)
      ctx.logger.trace(
        { jobName: job.options.name, id: input.id, found: result !== null },
        'Job retrieved',
      )
      return result
    },
  })
}

function createAddProcedure(
  job: AnyJob,
  config: AddOperationConfig<AnyJob, any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    input: createAddInputSchema(job),
    output: addOutputSchema,
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: async (ctx: DependencyContext<JobManagerDeps>, input) => {
      let jobData = input.data

      ctx.logger.debug(
        {
          jobName: job.options.name,
          jobId: input.jobId,
          priority: input.priority,
        },
        'Adding job',
      )

      // Call beforeAdd hook if provided
      if (config.beforeAdd) {
        ctx.logger.debug(
          { jobName: job.options.name },
          'Running beforeAdd hook',
        )
        jobData = await config.beforeAdd(ctx as any, jobData)
      }

      const queueResult = await ctx.jobManager.add(job, jobData, {
        jobId: input.jobId,
        priority: input.priority ?? config.options?.priority,
        delay: input.delay ?? config.options?.delay,
        attempts: config.options?.attempts,
      })

      const result = { id: queueResult.id!, name: queueResult.name }

      ctx.logger.info({ jobName: job.options.name, id: result.id }, 'Job added')

      // Call afterAdd hook if provided
      if (config.afterAdd) {
        ctx.logger.trace(
          { jobName: job.options.name, id: result.id },
          'Running afterAdd hook',
        )
        await config.afterAdd(ctx as any, result, jobData)
      }

      return result
    },
  })
}

function createRetryProcedure(
  job: AnyJob,
  config: RetryOperationConfig<any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    input: retryInputSchema,
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: async (ctx: DependencyContext<JobManagerDeps>, input) => {
      const clearState = input.clearState ?? config.clearState

      ctx.logger.debug(
        { jobName: job.options.name, id: input.id, clearState },
        'Retrying job',
      )

      // Call beforeRetry hook if provided
      if (config.beforeRetry) {
        ctx.logger.trace(
          { jobName: job.options.name, id: input.id },
          'Running beforeRetry hook',
        )
        await config.beforeRetry(ctx as any, { id: input.id, clearState })
      }

      await ctx.jobManager.retry(job, input.id, { clearState })

      ctx.logger.info(
        { jobName: job.options.name, id: input.id },
        'Job retried',
      )

      // Call afterRetry hook if provided
      if (config.afterRetry) {
        ctx.logger.trace(
          { jobName: job.options.name, id: input.id },
          'Running afterRetry hook',
        )
        await config.afterRetry(ctx as any, { id: input.id, clearState })
      }
    },
  })
}

function createCancelProcedure(
  job: AnyJob,
  config: CancelOperationConfig<any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    input: idInputSchema,
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: async (ctx: DependencyContext<JobManagerDeps>, input) => {
      ctx.logger.debug(
        { jobName: job.options.name, id: input.id },
        'Canceling job',
      )

      // Call beforeCancel hook if provided
      if (config.beforeCancel) {
        ctx.logger.trace(
          { jobName: job.options.name, id: input.id },
          'Running beforeCancel hook',
        )
        await config.beforeCancel(ctx as any, { id: input.id })
      }

      await ctx.jobManager.cancel(job, input.id)

      ctx.logger.info(
        { jobName: job.options.name, id: input.id },
        'Job canceled',
      )

      // Call afterCancel hook if provided
      if (config.afterCancel) {
        ctx.logger.trace(
          { jobName: job.options.name, id: input.id },
          'Running afterCancel hook',
        )
        await config.afterCancel(ctx as any, { id: input.id })
      }
    },
  })
}

function createRemoveProcedure(
  job: AnyJob,
  config: RemoveOperationConfig<any> = {},
  shared: { guards?: AnyGuard[]; middlewares?: AnyMiddleware[] },
): AnyProcedure {
  const allGuards = [...(shared.guards ?? []), ...(config.guards ?? [])]
  const allMiddlewares = [
    ...(shared.middlewares ?? []),
    ...(config.middlewares ?? []),
  ]

  const deps: JobManagerDeps = { jobManager, logger: CoreInjectables.logger }

  return createProcedure({
    input: idInputSchema,
    dependencies: { ...deps, ...(config.dependencies ?? {}) },
    guards: allGuards,
    middlewares: allMiddlewares,
    metadata: config.metadata,
    timeout: config.timeout,
    handler: async (ctx: DependencyContext<JobManagerDeps>, input) => {
      ctx.logger.debug(
        { jobName: job.options.name, id: input.id },
        'Removing job',
      )

      // Call beforeRemove hook if provided
      if (config.beforeRemove) {
        ctx.logger.trace(
          { jobName: job.options.name, id: input.id },
          'Running beforeRemove hook',
        )
        await config.beforeRemove(ctx as any, { id: input.id })
      }

      await ctx.jobManager.remove(job, input.id)

      ctx.logger.info(
        { jobName: job.options.name, id: input.id },
        'Job removed',
      )

      // Call afterRemove hook if provided
      if (config.afterRemove) {
        ctx.logger.trace(
          { jobName: job.options.name, id: input.id },
          'Running afterRemove hook',
        )
        await config.afterRemove(ctx as any, { id: input.id })
      }
    },
  })
}

// ============================================================================
// Main router factory
// ============================================================================

/**
 * Merge default operations with job-specific overrides
 */
function mergeOperations(
  defaults: DefaultOperations = {},
  overrides: JobOperations = {},
): JobOperations {
  const result: JobOperations = {}

  const ops = [
    'info',
    'list',
    'get',
    'add',
    'retry',
    'cancel',
    'remove',
  ] as const

  for (const op of ops) {
    const override = overrides[op]
    const defaultOp = defaults[op]

    if (override === false) {
      result[op] = false
    } else if (override !== undefined) {
      // Override provided - use it (merged with default base config if both are objects)
      if (
        defaultOp &&
        (defaultOp as unknown) !== false &&
        typeof override === 'object'
      ) {
        result[op] = {
          ...(defaultOp as object),
          ...(override as object),
          guards: [
            ...((defaultOp as any).guards ?? []),
            ...((override as any).guards ?? []),
          ],
          middlewares: [
            ...((defaultOp as any).middlewares ?? []),
            ...((override as any).middlewares ?? []),
          ],
        } as any
      } else {
        result[op] = override as any
      }
    } else if (defaultOp !== undefined) {
      result[op] = defaultOp as any
    }
    // else: undefined = use default behavior (enabled with empty config)
  }

  return result
}

/**
 * Creates a router with CRUD-like operations for multiple jobs.
 *
 * @example
 * ```ts
 * const jobsRouter = createJobsRouter({
 *   jobs: [userJob, emailJob] as const,
 *   guards: [authGuard],
 *   defaults: {
 *     list: {},
 *     get: {},
 *     add: {},
 *     retry: { guards: [adminGuard] },
 *     cancel: { guards: [adminGuard] },
 *     remove: false,
 *   },
 *   overrides: {
 *     userProcessing: {
 *       add: jobOperation({
 *         dependencies: { userService },
 *         beforeAdd: async (ctx, input) => ({
 *           ...input,
 *           userId: ctx.userService.getCurrentId(),
 *         }),
 *       }),
 *     },
 *   },
 * })
 *
 * // Use in your router
 * createRouter({
 *   routes: {
 *     jobs: jobsRouter,
 *   }
 * })
 * ```
 */
export function createJobsRouter<const Jobs extends Record<string, AnyJob>>(
  options: CreateJobsRouterOptions<Jobs>,
): JobsRouter<Jobs> {
  const {
    jobs,
    guards: sharedGuards = [],
    middlewares: sharedMiddlewares = [],
    defaults = {},
    overrides = {},
  } = options

  const routes: Record<string, AnyRouter> = {}
  const shared = { guards: sharedGuards, middlewares: sharedMiddlewares }

  for (const jobName in jobs) {
    const job = jobs[jobName]
    const jobOverrides =
      (overrides as Record<string, JobOperations>)[jobName] ?? {}

    // Merge defaults with job-specific overrides
    const operations = mergeOperations(defaults, jobOverrides)

    const jobRoutes: Record<string, AnyProcedure> = {}

    // Generate each enabled operation
    if (operations.info !== false) {
      jobRoutes.info = createInfoProcedure(
        job,
        operations.info as InfoOperationConfig,
        shared,
      )
    }

    if (operations.list !== false) {
      jobRoutes.list = createListProcedure(
        job,
        operations.list as ListOperationConfig,
        shared,
      )
    }

    if (operations.get !== false) {
      jobRoutes.get = createGetProcedure(
        job,
        operations.get as GetOperationConfig,
        shared,
      )
    }

    if (operations.add !== false) {
      jobRoutes.add = createAddProcedure(
        job,
        operations.add as AddOperationConfig,
        shared,
      )
    }

    if (operations.retry !== false) {
      jobRoutes.retry = createRetryProcedure(
        job,
        operations.retry as RetryOperationConfig,
        shared,
      )
    }

    if (operations.cancel !== false) {
      jobRoutes.cancel = createCancelProcedure(
        job,
        operations.cancel as CancelOperationConfig,
        shared,
      )
    }

    if (operations.remove !== false) {
      jobRoutes.remove = createRemoveProcedure(
        job,
        operations.remove as RemoveOperationConfig,
        shared,
      )
    }

    // Create router for this job (named by job name)
    routes[jobName] = createRouter({ routes: jobRoutes })
  }

  // Return router containing all job routers
  return createRouter({ routes }) as JobsRouter<Jobs>
}
