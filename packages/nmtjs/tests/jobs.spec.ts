import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { JobWorkerPool } from '../src/runtime/enums.ts'
import { createJob } from '../src/runtime/jobs/job.ts'
import { JobManager } from '../src/runtime/jobs/manager.ts'
import { createJobsRouter } from '../src/runtime/jobs/router.ts'
import { createStep, isJobStep } from '../src/runtime/jobs/step.ts'

describe('jobs builder', () => {
  it('creates step metadata and detects valid steps', () => {
    const step = createStep({
      label: 'parse',
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number() }),
      handler: async (_ctx, input) => ({ value: input.seed + 1 }),
    })

    expect(isJobStep(step)).toBe(true)
    expect(step.label).toBe('parse')
    expect(step.dependencies).toEqual({})
    expect(Object.isFrozen(step)).toBe(true)
  })

  it('builds job with linear + parallel steps metadata', () => {
    const step1 = createStep({
      label: 'step1',
      input: t.object({ seed: t.number() }),
      output: t.object({ a: t.number() }),
      handler: async (_ctx, input) => ({ a: input.seed + 1 }),
    })

    const step2 = createStep({
      label: 'step2',
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ b: t.number() }),
      handler: async (_ctx, input) => ({ b: input.a + 10 }),
    })

    const step3 = createStep({
      label: 'step3',
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ c: t.number() }),
      handler: async (_ctx, input) => ({ c: input.seed + input.a }),
    })

    const step4 = createStep({
      label: 'step4',
      input: t.object({
        seed: t.number(),
        a: t.number(),
        b: t.number(),
        c: t.number(),
      }),
      output: t.object({ done: t.number() }),
      handler: async (_ctx, input) => ({ done: input.b + input.c }),
    })

    const job = createJob({
      name: 'builder-shape',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
    })
      .step(step1)
      .steps(step2, step3)
      .step(step4)
      .return(({ result }) => ({ done: result.done }))

    expect(job.jobSteps).toHaveLength(4)
    expect(job.parallelGroups.get(1)).toBe(3)
    expect(job.parallelGroupByStepIndex.get(1)).toBe(1)
    expect(job.parallelGroupByStepIndex.get(2)).toBe(1)
    expect(job.parallelGroupByStepIndex.has(0)).toBe(false)
    expect(job.parallelGroupByStepIndex.has(3)).toBe(false)
  })

  it('stores conditional step only for .step calls', () => {
    const step1 = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ a: t.number() }),
      handler: async (_ctx, input) => ({ a: input.seed + 1 }),
    })

    const step2 = createStep({
      input: t.object({ seed: t.number(), a: t.number().optional() }),
      output: t.object({ b: t.number() }),
      handler: async (_ctx, input) => ({ b: (input.a ?? 0) + 10 }),
    })

    const step3 = createStep({
      input: t.object({ seed: t.number(), a: t.number().optional() }),
      output: t.object({ c: t.number() }),
      handler: async (_ctx, input) => ({ c: input.seed + (input.a ?? 0) }),
    })

    const condition = () => true

    const job = createJob({
      name: 'builder-condition',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({
        a: t.number().optional(),
        b: t.number().optional(),
        c: t.number().optional(),
      }),
    })
      .step(step1, condition)
      .steps(step2, step3)
      .return(({ result }) => ({ a: result.a, b: result.b, c: result.c }))

    expect(job.conditions.has(0)).toBe(true)
    expect(job.conditions.has(1)).toBe(false)
    expect(job.conditions.has(2)).toBe(false)
  })
})

describe('jobs types', () => {
  it('composes result types for linear + parallel steps', () => {
    const step1 = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ a: t.number() }),
      handler: async (_ctx, input) => ({ a: input.seed + 1 }),
    })

    const step2 = createStep({
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ b: t.string() }),
      handler: async () => ({ b: 'ok' }),
    })

    const step3 = createStep({
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ c: t.boolean() }),
      handler: async () => ({ c: true }),
    })

    const step4 = createStep({
      input: t.object({
        seed: t.number(),
        a: t.number(),
        b: t.string(),
        c: t.boolean(),
      }),
      output: t.object({ done: t.number() }),
      handler: async () => ({ done: 1 }),
    })

    const job = createJob({
      name: 'types-parallel',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
    })
      .step(step1)
      .steps(step2, step3)
      .step(step4)
      .return(({ result }) => ({ done: result.done }))

    expectTypeOf(0 as typeof job._.result.seed).toEqualTypeOf(0 as number)
    expectTypeOf(0 as typeof job._.result.a).toEqualTypeOf(0 as number)
    expectTypeOf('' as typeof job._.result.b).toEqualTypeOf('' as string)
    expectTypeOf(true as typeof job._.result.c).toEqualTypeOf(true as boolean)
    expectTypeOf(0 as typeof job._.result.done).toEqualTypeOf(0 as number)
  })

  it('rejects invalid step composition and output shape at compile time', () => {
    const step1 = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ a: t.number() }),
      handler: async (_ctx, input) => ({ a: input.seed + 1 }),
    })

    const step2 = createStep({
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ b: t.string() }),
      handler: async () => ({ b: 'ok' }),
    })

    createJob({
      name: 'types-invalid',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
    })
      // @ts-expect-error: .steps requires at least two steps
      .steps(step1)
      .return(() => ({ done: 1 }))

    const invalidParallelInputStep = createStep({
      input: t.object({ missing: t.string() }),
      output: t.object({ nope: t.boolean() }),
      handler: async () => ({ nope: true }),
    })

    createJob({
      name: 'types-invalid-parallel-input',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
    })
      .step(step1)
      // @ts-expect-error: parallel step input must be satisfied by accumulated job result
      .steps(step2, invalidParallelInputStep)
      .return(() => ({ done: 1 }))

    createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ right: t.number() }),
      // @ts-expect-error: step handler output must match declared output schema
      handler: async () => ({ asdasd: 1 }),
    })
  })

  it('rejects job data mismatch against step data type', () => {
    const validDataStep = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
      handler: async (_ctx, _input, data: { progress: { tick: number } }) => ({
        done: data.progress.tick,
      }),
    })

    const invalidDataStep = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
      handler: async (_ctx, _input, data: { progress: { wrong: string } }) => ({
        done: Number(data.progress.wrong),
      }),
    })

    const passthroughStep = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number() }),
      handler: async (_ctx, input) => ({ value: input.seed + 1 }),
    })

    createJob({
      name: 'types-job-data-compatible',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
      data: async () => ({ progress: { tick: 1 } }),
    })
      .step(validDataStep)
      .return(({ result }) => ({ done: result.done }))

    createJob({
      name: 'types-job-data-incompatible-step',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
      data: async () => ({ progress: { tick: 1 } }),
    })
      // @ts-expect-error: step data type must match job data type
      .step(invalidDataStep)
      .return(({ result }) => ({ done: result.done }))

    createJob({
      name: 'types-job-data-incompatible-parallel',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number(), done: t.number() }),
      data: async () => ({ progress: { tick: 1 } }),
    })
      // @ts-expect-error: all parallel steps must match job data type
      .steps(passthroughStep, invalidDataStep)
      .return(({ result }) => ({ value: result.value, done: result.done }))
  })
})

describe('jobs info metadata', () => {
  it('marks parallel steps in job manager info output', () => {
    const step1 = createStep({
      label: 'prepare',
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number() }),
      handler: async (_ctx, input) => ({ value: input.seed + 1 }),
    })

    const step2 = createStep({
      label: 'left',
      input: t.object({ seed: t.number(), value: t.number() }),
      output: t.object({ left: t.number() }),
      handler: async (_ctx, input) => ({ left: input.value + 1 }),
    })

    const step3 = createStep({
      label: 'right',
      input: t.object({ seed: t.number(), value: t.number() }),
      output: t.object({ right: t.number() }),
      handler: async (_ctx, input) => ({ right: input.value + 2 }),
    })

    const step4 = createStep({
      label: 'final',
      input: t.object({
        seed: t.number(),
        value: t.number(),
        left: t.number(),
        right: t.number(),
      }),
      output: t.object({ total: t.number() }),
      handler: async (_ctx, input) => ({ total: input.left + input.right }),
    })

    const job = createJob({
      name: 'info-parallel-manager',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ total: t.number() }),
    })
      .step(step1)
      .steps(step2, step3)
      .step(step4)
      .return(({ result }) => ({ total: result.total }))

    const manager = new JobManager({} as any, [job])
    const info = manager.getInfo(job)

    expect(info.name).toBe('info-parallel-manager')
    expect(info.steps).toEqual([
      { label: 'prepare', conditional: false, parallel: false },
      { label: 'left', conditional: false, parallel: true },
      { label: 'right', conditional: false, parallel: true },
      { label: 'final', conditional: false, parallel: false },
    ])
  })

  it('exposes parallel flags through createJobsRouter info procedure', async () => {
    const step1 = createStep({
      label: 'prepare',
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number() }),
      handler: async (_ctx, input) => ({ value: input.seed + 1 }),
    })

    const step2 = createStep({
      label: 'left',
      input: t.object({ seed: t.number(), value: t.number() }),
      output: t.object({ left: t.number() }),
      handler: async (_ctx, input) => ({ left: input.value + 1 }),
    })

    const step3 = createStep({
      label: 'right',
      input: t.object({ seed: t.number(), value: t.number() }),
      output: t.object({ right: t.number() }),
      handler: async (_ctx, input) => ({ right: input.value + 2 }),
    })

    const step4 = createStep({
      label: 'final',
      input: t.object({
        seed: t.number(),
        value: t.number(),
        left: t.number(),
        right: t.number(),
      }),
      output: t.object({ total: t.number() }),
      handler: async (_ctx, input) => ({ total: input.left + input.right }),
    })

    const job = createJob({
      name: 'info-parallel-router',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ total: t.number() }),
      progress: t.object({}),
    })
      .step(step1)
      .steps(step2, step3)
      .step(step4)
      .return(({ result }) => ({ total: result.total }))

    const manager = new JobManager({} as any, [job]).publicInstance
    const jobsRouter = createJobsRouter({ jobs: { sample: job } })

    const info = await jobsRouter.routes.sample.routes.info.handler({
      jobManager: manager,
      logger: { trace: () => {} },
    } as any)

    expect(info).toEqual({
      name: 'info-parallel-router',
      steps: [
        { label: 'prepare', conditional: false, parallel: false },
        { label: 'left', conditional: false, parallel: true },
        { label: 'right', conditional: false, parallel: true },
        { label: 'final', conditional: false, parallel: false },
      ],
    })
  })
})

describe('jobs router', () => {
  function createRouterFixtureJob(name: string) {
    return createJob({
      name,
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number() }),
      progress: t.object({}),
    })
      .step(
        createStep({
          input: t.object({ seed: t.number() }),
          output: t.object({ value: t.number() }),
          handler: async (_ctx, input) => ({ value: input.seed + 1 }),
        }),
      )
      .return(({ result }) => ({ value: result.value }))
  }

  it('creates operations per job and respects defaults + overrides', () => {
    const alpha = createRouterFixtureJob('router-alpha')
    const beta = createRouterFixtureJob('router-beta')

    const jobsRouter = createJobsRouter({
      jobs: { alpha, beta },
      defaults: { remove: false },
      overrides: { beta: { add: false, remove: {} } },
    })

    expect(Object.keys(jobsRouter.routes.alpha.routes).sort()).toEqual([
      'add',
      'cancel',
      'get',
      'info',
      'list',
      'retry',
    ])

    expect(Object.keys(jobsRouter.routes.beta.routes).sort()).toEqual([
      'cancel',
      'get',
      'info',
      'list',
      'remove',
      'retry',
    ])
  })

  it('merges add operation options and applies beforeAdd hook', async () => {
    const sample = createRouterFixtureJob('router-hooks')

    let capturedData: unknown
    let capturedOptions: unknown

    const jobsRouter = createJobsRouter({
      jobs: { sample },
      defaults: { add: { options: { priority: 10, attempts: 3, delay: 20 } } },
      overrides: {
        sample: {
          add: { beforeAdd: async (_ctx, input) => ({ seed: input.seed + 1 }) },
        },
      },
    })

    const response = await jobsRouter.routes.sample.routes.add.handler(
      {
        jobManager: {
          add: async (_job: unknown, data: unknown, options: unknown) => {
            capturedData = data
            capturedOptions = options
            return { id: 'job-1', name: 'router-hooks' }
          },
        },
        logger: { debug: () => {}, trace: () => {}, info: () => {} },
      } as any,
      { data: { seed: 1 } },
    )

    expect(response).toEqual({ id: 'job-1', name: 'router-hooks' })
    expect(capturedData).toEqual({ seed: 2 })
    expect(capturedOptions).toEqual({
      jobId: undefined,
      priority: 10,
      delay: 20,
      attempts: 3,
    })
  })

  it('merges default and override guards/middlewares for operations', () => {
    const sample = createRouterFixtureJob('router-guards')

    const defaultGuard = Symbol('default-guard') as any
    const overrideGuard = Symbol('override-guard') as any
    const defaultMiddleware = Symbol('default-middleware') as any
    const overrideMiddleware = Symbol('override-middleware') as any

    const jobsRouter = createJobsRouter({
      jobs: { sample },
      defaults: {
        add: { guards: [defaultGuard], middlewares: [defaultMiddleware] },
      },
      overrides: {
        sample: {
          add: { guards: [overrideGuard], middlewares: [overrideMiddleware] },
        },
      },
    })

    const addProcedure = jobsRouter.routes.sample.routes.add

    expect(Array.from(addProcedure.guards)).toEqual([
      defaultGuard,
      overrideGuard,
    ])
    expect(Array.from(addProcedure.middlewares)).toEqual([
      defaultMiddleware,
      overrideMiddleware,
    ])
  })
})
