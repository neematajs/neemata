import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import {
  runExecutionWorker as runEffectExecutionWorker,
  type HandlerRuntime,
  type Requirements,
} from '../src/effect/index.ts'
import { defineWorkflowsWorker as defineEffectWorkflowsWorker } from '../src/effect/neem.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

describe('in-memory createAttempt after a predecessor', () => {
  async function createChild() {
    const runtime = createInMemoryWorkflowRuntime()
    const { store } = runtime
    const run = await store.createRun({
      workflowName: 'review2.hosts.after',
      input: {},
    })
    const ref = { runId: run.id, nodeName: 'work', childKey: '$self' }
    await store.createNode({ runId: run.id, name: 'work', kind: 'activity' })
    await store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'work',
      children: [{ childKey: '$self', kind: 'activity' }],
    })
    const child = async () =>
      (await store.loadNodeSnapshot(ref))!.children.find(
        (candidate) => candidate.childKey === '$self',
      )!
    return { store, ref, child }
  }

  it('shares one successor between two retries of the same failed attempt', async () => {
    const { store, ref, child } = await createChild()
    const first = await store.createAttempt({ ...ref, input: {} })
    await store.failCurrentAttempt({
      attemptId: first.id,
      leaseToken: first.leaseToken!,
      error: new Error('failed'),
    })

    // `after` is still current: the retry is created.
    const retry = await store.createAttempt({
      ...ref,
      input: {},
      after: first.id,
    })
    expect(retry.id).not.toBe(first.id)
    expect(retry.retryAttemptNumber).toBe(2)

    // A worker that lost the claim replays the same retry.
    const replayed = await store.createAttempt({
      ...ref,
      input: {},
      after: first.id,
    })
    expect(replayed).toStrictEqual(retry)
    expect(await child()).toMatchObject({
      currentAttemptId: retry.id,
      attemptCount: 2,
    })
    expect((await store.loadNodeSnapshot(ref))!.attempts).toHaveLength(2)
  })

  it('returns a successor that already settled the child', async () => {
    const { store, ref, child } = await createChild()
    const first = await store.createAttempt({ ...ref, input: {} })
    const retry = await store.createAttempt({
      ...ref,
      input: {},
      after: first.id,
    })
    const completed = await store.completeCurrentAttempt({
      attemptId: retry.id,
      leaseToken: retry.leaseToken!,
      output: {},
    })

    await expect(
      store.createAttempt({ ...ref, input: {}, after: first.id }),
    ).resolves.toStrictEqual(completed)
    expect(await child()).toMatchObject({ attemptCount: 2 })
  })

  it('creates unconditionally without `after`', async () => {
    const { store, ref, child } = await createChild()
    const first = await store.createAttempt({ ...ref, input: {} })
    const second = await store.createAttempt({ ...ref, input: {} })
    expect(second.id).not.toBe(first.id)
    expect(await child()).toMatchObject({
      currentAttemptId: second.id,
      attemptCount: 2,
    })
  })
})

describe('in-memory retention', () => {
  const text = z.string()
  const child = defineWorkflow({
    name: 'review2.hosts.detached-child',
    input: text,
    output: text,
  })
    .activity('work', { input: text, output: text })
    .build()
  const childImplementation = implementWorkflow(child, { pool: 'test' })
    .work(async (input) => `${input}!`)
    .finish(({ work }) => work)
  const parent = defineWorkflow({
    name: 'review2.hosts.detaching-parent',
    input: text,
    output: text,
  })
    .workflow('sub', child, { cancellation: 'detach' })
    .build()
  const parentImplementation = implementWorkflow(parent, { pool: 'test' })
    .sub(child)
    .finish(() => 'done')

  it('keeps a family whose detached child is still running', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [parentImplementation, childImplementation],
      tasks: [],
      workerId: 'review2',
    }
    const run = await client.start(parent, 'hi')
    // Parks the parent on its child; the child stays live on its unclaimed activity.
    await runWorkflowWorker(workers)
    const childRunId = (await client.get(run.id))!.children[0]!.childRunId!
    await client.cancel(run.id)
    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect((await client.get(childRunId))!.run.status).toBe('running')

    const prune = () =>
      runtime.store.pruneTerminalRuns({
        olderThan: Number.MAX_SAFE_INTEGER,
      })
    expect(await prune()).toStrictEqual({ deleted: 0 })
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect((await client.get(childRunId))!.run.status).toBe('running')
    expect(runtime.inspect().activityCommands).toHaveLength(1)

    for (let round = 0; round < 4; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
    expect((await client.get(childRunId))!.run.status).toBe('completed')

    expect(await prune()).toStrictEqual({ deleted: 1 })
    expect(await client.get(run.id)).toBeUndefined()
    expect(await client.get(childRunId)).toBeUndefined()
  })
})

describe('core handler env subtypes in Effect workers', () => {
  class Service extends Context.Service<Service, { value: number }>()(
    'review2/hosts/Service',
  ) {}
  type Db = { readonly db: { read(): number } }
  const io = { input: z.number(), output: z.number() }
  const task = defineTask({ name: 'review2.hosts.core-task', ...io })
  const coreWorkflow = defineWorkflow({
    name: 'review2.hosts.core-workflow',
    ...io,
  }).build()
  const runtime = Effect.sync(createInMemoryWorkflowRuntime)
  const layer = Layer.succeed(Service, { value: 1 })

  const needsDbToo = implementTask(task, {
    pool: 'test',
    handler: (_input, _lifecycle, env: HandlerRuntime<Service> & Db) =>
      env.db.read(),
  })
  const finishNeedsDbToo = implementWorkflow(coreWorkflow, {
    pool: 'test',
  }).finish((_outputs, _input, _lifecycle, env: HandlerRuntime & Db) =>
    env.db.read(),
  )
  const usesRuntime = implementTask(task, {
    pool: 'test',
    handler: (_input, lifecycle, env: HandlerRuntime<Service>) =>
      env.run(
        () => Service.pipe(Effect.map(({ value }) => value)),
        lifecycle.signal,
      ),
  })

  it('rejects an env that asks for more than the handler runtime', () => {
    expectTypeOf<Requirements<typeof usesRuntime>>().toEqualTypeOf<Service>()
    expectTypeOf<Requirements<typeof needsDbToo>>().not.toEqualTypeOf<Service>()
    expectTypeOf<
      Requirements<typeof finishNeedsDbToo>
    >().not.toEqualTypeOf<never>()

    const workflows = () => []
    defineEffectWorkflowsWorker({
      workflows,
      tasks: () => [needsDbToo],
      runtime,
      // @ts-expect-error The Layer covers the services, nothing covers db.
      layer,
    })
    // @ts-expect-error Finish handlers are checked the same way.
    defineEffectWorkflowsWorker({
      workflows: () => [finishNeedsDbToo],
      runtime,
    })
    const worker = {
      ...createInMemoryWorkflowRuntime(),
      workflows: [],
      workerId: 'review2-hosts',
    }
    // Thunk: only the call's types matter, the worker must not run.
    void (() =>
      runEffectExecutionWorker({
        ...worker,
        tasks: [needsDbToo],
        // @ts-expect-error The context cannot carry the task's db.
        context: Context.make(Service, { value: 1 }),
      }))

    expect(
      defineEffectWorkflowsWorker({
        workflows,
        tasks: () => [usesRuntime],
        runtime,
        layer,
      }),
    ).toBeDefined()
  })
})
