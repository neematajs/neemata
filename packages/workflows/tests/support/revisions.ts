import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../src/implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunnableDefinition,
} from '../../src/index.ts'
import type { WorkflowRuntimeAdapter } from '../../src/runtime/index.ts'
import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../../src/index.ts'
import {
  captureGraphPresentation,
  projectStructure,
} from '../../src/inspector/index.ts'
import { continueRunCommand } from '../../src/runtime/commands.ts'
import {
  describeDefinition,
  runDefinitionInput,
} from '../../src/runtime/definition.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  WorkflowDefinitionConflictError,
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../../src/runtime/index.ts'
import { startStoredScheduleRun } from '../../src/runtime/scheduler.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from '../../src/runtime/worker.ts'

export type RevisionsRuntimeFactory = (options?: {
  readonly maxDeliveries?: number
}) => WorkflowRuntimeAdapter | Promise<WorkflowRuntimeAdapter>

type Served = {
  readonly workflows: readonly WorkflowImplementation<
    AnyWorkflowDefinition,
    any
  >[]
  readonly tasks: readonly TaskImplementation<AnyTaskDefinition, any>[]
}

const text = z.string()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type DeployOptions = {
  readonly title?: string
  readonly timeout?: `${number}ms` | `${number}h`
}

/**
 * One deployed generation of a small family: a task, a child workflow and a
 * parent using every node kind. Each handler stamps its own revision into its
 * output, so a run's result proves which code executed it.
 */
function deploy(
  prefix: string,
  revision: string | undefined,
  options: DeployOptions = {},
) {
  const tag = revision ?? 'legacy'
  const { title, timeout } = options
  const labels = title === undefined ? {} : { title }

  const task = defineTask({
    name: `${prefix}.task`,
    revision,
    input: text,
    output: text,
    ...labels,
  })
  const taskImplementation = implementTask(task, {
    pool: 'test',
    handler: async (input) => `${input}|task@${tag}`,
  })

  const child = defineWorkflow({
    name: `${prefix}.child`,
    revision,
    input: text,
    output: text,
    ...labels,
  })
    .activity('step', { input: text, output: text, ...labels })
    .build()
  const childImplementation = implementWorkflow(child, { pool: 'test' })
    .step(async (input) => `${input}|child@${tag}`)
    .finish(({ step }) => step)

  const activity = { input: text, output: text }
  const parent = defineWorkflow({
    name: `${prefix}.parent`,
    revision,
    input: text,
    output: z.array(text),
    timeout,
    ...labels,
  })
    .activity('first', { ...activity, ...labels })
    .task('work', task, labels)
    .branch('route', {
      output: text,
      ...labels,
      cases: (helpers) => ({
        viaTask: helpers.task(task, labels),
        viaChild: helpers.workflow(child, labels),
      }),
    })
    .parallel('both', (helpers) => ({
      left: helpers.task(task),
      right: helpers.workflow(child),
      inline: helpers.activity(activity),
    }))
    .mapTask('each', task, { item: text })
    .mapWorkflow('eachChild', child, { item: text })
    .build()

  const parentImplementation = implementWorkflow(parent, { pool: 'test' })
    .first(async (input) => `${input}|first@${tag}`)
    .work(task)
    .route({
      select: (_outputs, input) =>
        input.startsWith('child') ? 'viaChild' : 'viaTask',
      cases: (helpers) => ({
        viaTask: helpers.task(task),
        viaChild: helpers.workflow(child),
      }),
    })
    .both((helpers) => ({
      left: helpers.task(task),
      right: helpers.workflow(child),
      inline: helpers.activity(async (input) => `${input}|inline@${tag}`),
    }))
    .each(task, { items: () => ['a', 'b'], input: (_outputs, item) => item })
    .eachChild(child, { items: () => ['c'], input: (_outputs, item) => item })
    .finish(({ first, work, route, both, each, eachChild }) => [
      first,
      work,
      route,
      both.left,
      both.right,
      both.inline,
      ...each.items.map(({ output }) => output),
      ...eachChild.items.map(({ output }) => output),
    ])
  return {
    tag,
    task,
    child,
    parent,
    workflows: [parentImplementation, childImplementation],
    tasks: [taskImplementation],
  } satisfies Served & Record<string, unknown>
}

/**
 * The parent of `deploy` under the same name and revision with another graph:
 * what editing a workflow in place without a new revision looks like.
 */
function reshape(prefix: string, revision: string | undefined) {
  const parent = defineWorkflow({
    name: `${prefix}.parent`,
    revision,
    input: text,
    output: z.array(text),
  })
    .activity('first', { input: text, output: text })
    .build()
  const implementation = implementWorkflow(parent, { pool: 'test' })
    .first(async (input) => `${input}|reshaped`)
    .finish(({ first }) => [first])

  return { parent, workflows: [implementation], tasks: [] } satisfies Served &
    Record<string, unknown>
}

function serve(...deployments: readonly Served[]): Served {
  return {
    workflows: deployments.flatMap(({ workflows }) => workflows),
    tasks: deployments.flatMap(({ tasks }) => tasks),
  }
}

const quiet = { reaping: false, runTimeouts: false } as const

/** Runs both worker roles until neither finds work, and counts what they did. */
async function drain(runtime: WorkflowRuntimeAdapter, served: Served) {
  let processed = 0
  for (let pass = 0; pass < 200; pass++) {
    const coordination = await runWorkflowWorker({
      ...runtime,
      ...quiet,
      workflows: served.workflows,
      workerId: 'coordinator',
    })
    const execution = await runExecutionWorker({
      ...runtime,
      reaping: false,
      workflows: served.workflows,
      tasks: served.tasks,
      workerId: 'execution',
    })
    const done = coordination.processed + execution.processed
    if (done === 0) return processed
    processed += done
  }
  throw new Error('Workers did not settle')
}

function refOf({ kind, name, revision }: RunnableDefinition) {
  return { kind, name, revision: revision! }
}

export function revisionsContract(
  adapter: string,
  runtimeFactory: RevisionsRuntimeFactory,
  options: { readonly skip?: boolean } = {},
) {
  describe.skipIf(options.skip)(`${adapter} execution revisions`, () => {
    const runtimes: WorkflowRuntimeAdapter[] = []
    const createRuntime: RevisionsRuntimeFactory = async (options) => {
      const runtime = await runtimeFactory(options)
      runtimes.push(runtime)
      return runtime
    }
    // Adapters under test may share one database or server across specs.
    const unique = (label: string) => `rev.${label}.${randomUUID().slice(0, 8)}`

    afterEach(async () => {
      await Promise.allSettled(
        runtimes.splice(0).map(async (runtime) => await runtime.dispose?.()),
      )
    })

    describe('pinning', () => {
      it('pins a run to the revision of the definition it was started from', async () => {
        const prefix = unique('pin')
        const v1 = deploy(prefix, 'v1')
        const legacy = deploy(prefix, undefined)
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const pinned = await client.start(v1.parent, 'x')
        const loose = await client.start(legacy.parent, 'x')

        expect(pinned.executionRevision).toBe('v1')
        expect(pinned.graphHash).toBe(describeDefinition(v1.parent).graphHash)
        expect(loose.executionRevision).toBeUndefined()
        // Topology is the same, so the hash is; the revision is what differs.
        expect(loose.graphHash).toBe(pinned.graphHash)

        const stored = (await client.get(pinned.id))!.run
        expect(stored.executionRevision).toBe('v1')
        expect(stored.graphHash).toBe(pinned.graphHash)

        const byRevision = async (executionRevision: string | null) => {
          const { runs } = await client.list({
            name: v1.parent.name,
            executionRevision,
          })
          return runs.map(({ id }) => id)
        }
        expect(await byRevision('v1')).toStrictEqual([pinned.id])
        expect(await byRevision(null)).toStrictEqual([loose.id])
        expect(await byRevision('v2')).toStrictEqual([])
        const { runs: summaries } = await client.listSummaries({
          name: v1.parent.name,
          executionRevision: 'v1',
        })
        expect(summaries).toMatchObject([
          {
            id: pinned.id,
            executionRevision: 'v1',
            graphHash: pinned.graphHash,
          },
        ])
      })

      it('keeps every child of a v1 parent on v1 after v2 is deployed', async () => {
        const prefix = unique('family')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const viaTask = await client.start(v1.parent, 'x')
        const viaChild = await client.start(v1.parent, 'child-y')
        // One coordination pass under v1 alone: only the first activity
        // exists so far, every child is created after v2 is deployed.
        await runWorkflowWorker({
          ...runtime,
          ...quiet,
          workflows: v1.workflows,
          workerId: 'early',
        })
        const next = await client.start(v2.parent, 'x')
        await drain(runtime, serve(v1, v2))

        for (const [run, tag] of [
          [viaTask, 'v1'],
          [viaChild, 'v1'],
          [next, 'v2'],
        ] as const) {
          const snapshot = (await client.get(run.id))!
          expect(snapshot.run.status).toBe('completed')
          const output = snapshot.run.output as string[]
          expect(output).toHaveLength(9)
          for (const line of output) expect(line.endsWith(`@${tag}`)).toBe(true)

          const family = await client.getFamily(run.id)
          // parent + work + route + both.left + both.right + each×2 + eachChild
          expect(family).toHaveLength(8)
          for (const entry of family) {
            expect(entry.run.executionRevision).toBe(tag)
            expect(entry.run.graphHash).toBeDefined()
          }
        }
        expect(
          ((await client.get(viaChild.id))!.run.output as string[])[2],
        ).toBe('child-y|child@v1')
      })

      it('lets an unversioned parent run versioned children', async () => {
        const prefix = unique('mixed')
        const v1 = deploy(prefix, 'v1')
        const loose = defineWorkflow({
          name: `${prefix}.loose`,
          input: text,
          output: text,
        })
          .workflow('sub', v1.child)
          .build()
        const looseImplementation = implementWorkflow(loose, { pool: 'test' })
          .sub(v1.child)
          .finish(({ sub }) => sub)
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(loose, 'x')
        await drain(
          runtime,
          serve(v1, { workflows: [looseImplementation], tasks: [] }),
        )

        const [parent, child] = await client.getFamily(run.id)
        expect(parent!.run).toMatchObject({ status: 'completed' })
        expect(parent!.run.executionRevision).toBeUndefined()
        // The child brought its own definitions: nothing was saved for it
        // when the unversioned root started.
        expect(child!.run.executionRevision).toBe('v1')
        expect(await client.getDefinition(refOf(v1.child))).toMatchObject({
          graph: { structure: projectStructure(v1.child) },
        })
      })
    })

    describe('routing', () => {
      it('leaves work of an unserved revision queued and untouched', async () => {
        const prefix = unique('parked')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const legacy = deploy(prefix, undefined)
        const runtime = await createRuntime({ maxDeliveries: 2 })
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        for (let poll = 0; poll < 5; poll++) {
          expect(await drain(runtime, serve(v2, legacy))).toBe(0)
        }
        // Never claimed, so never counted: even a delivery budget of two
        // is not spent by workers that cannot run it.
        expect((await client.get(run.id))!.run.status).toBe('queued')
        expect(await client.listDeadCommands({ runId: run.id })).toHaveLength(0)

        await drain(runtime, serve(v1))
        expect((await client.get(run.id))!.run.status).toBe('completed')
      })

      it('parks a run mid-flight when its revision stops being served', async () => {
        const prefix = unique('midflight')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime({ maxDeliveries: 2 })
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        await runWorkflowWorker({
          ...runtime,
          ...quiet,
          workflows: v1.workflows,
          workerId: 'coordinator',
        })
        // The first activity is dispatched; only v2 code is running now.
        for (let poll = 0; poll < 5; poll++) {
          expect(await drain(runtime, serve(v2))).toBe(0)
        }
        const parked = (await client.get(run.id))!
        expect(parked.run.status).toBe('running')
        expect(parked.attempts).toMatchObject([{ status: 'started' }])
        expect(await client.listDeadCommands({ runId: run.id })).toHaveLength(0)

        await drain(runtime, serve(v1))
        expect((await client.get(run.id))!.run.status).toBe('completed')
      })

      it('keeps the unversioned lane and versioned lanes apart', async () => {
        const prefix = unique('lanes')
        const v1 = deploy(prefix, 'v1')
        const legacy = deploy(prefix, undefined)
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const loose = await client.start(legacy.parent, 'x')
        const pinned = await client.start(v1.parent, 'x')

        await drain(runtime, serve(v1))
        expect((await client.get(pinned.id))!.run.status).toBe('completed')
        expect((await client.get(loose.id))!.run.status).toBe('queued')

        await drain(runtime, serve(legacy))
        const settled = (await client.get(loose.id))!.run
        expect(settled.status).toBe('completed')
        for (const line of settled.output as string[]) {
          expect(line.endsWith('@legacy')).toBe(true)
        }
      })

      it('claims continue, task and activity commands by exact route only', async () => {
        const name = unique('claim')
        const worker = { workerId: 'claims', leaseMs: 30_000 }
        const v1 = defineWorkflow({ name, revision: 'v1', input: text }).build()
        const runtime = await createRuntime()
        const { store, runCoordinationExecutor, attemptExecutor } = runtime
        const run = await store.createRun({
          workflowName: name,
          input: 'x',
          ...runDefinitionInput(v1),
        })

        await runCoordinationExecutor.enqueue(continueRunCommand(run))
        for (const workflows of [[{ name }], [{ name, revision: 'v2' }], []]) {
          expect(
            await runCoordinationExecutor.claim({ ...worker, workflows }),
          ).toBeNull()
        }
        const continued = await runCoordinationExecutor.claim({
          ...worker,
          workflows: [{ name, revision: 'v1' }],
        })
        expect(continued?.command).toStrictEqual({
          kind: 'continueRun',
          runId: run.id,
          workflowName: name,
          revision: 'v1',
        })
        await runCoordinationExecutor.ack(continued!)

        const attempt = () => ({
          runId: run.id,
          nodeName: 'node',
          childKey: '$self',
          attemptId: randomUUID(),
          leaseToken: randomUUID(),
          input: null,
        })
        // An activity named like a revision, and a revision named like an
        // activity: neither lane may mistake one segment for the other.
        const versioned = {
          ...attempt(),
          kind: 'activityAttempt' as const,
          workflowName: name,
          revision: 'v1',
          activityName: 'send',
        }
        const lookalike = {
          ...attempt(),
          kind: 'activityAttempt' as const,
          workflowName: name,
          activityName: 'v1',
        }
        await attemptExecutor.dispatchActivity(versioned)
        await attemptExecutor.dispatchActivity(lookalike)

        const claimActivity = (
          revision: string | undefined,
          activityNames?: string[],
        ) =>
          attemptExecutor.claim({
            ...worker,
            workflows: [
              { name, ...(revision === undefined ? {} : { revision }) },
            ],
            ...(activityNames === undefined ? {} : { activityNames }),
            tasks: [],
          })

        expect(await claimActivity('v2')).toBeNull()
        expect(await claimActivity(undefined, ['send'])).toBeNull()
        expect(await claimActivity('v1', ['v1'])).toBeNull()
        const legacyClaim = await claimActivity(undefined, ['v1'])
        expect(legacyClaim?.command).toMatchObject({
          attemptId: lookalike.attemptId,
        })
        await attemptExecutor.ack(legacyClaim!)
        expect(await claimActivity(undefined)).toBeNull()
        const versionedClaim = await claimActivity('v1', ['send'])
        expect(versionedClaim?.command).toMatchObject({
          attemptId: versioned.attemptId,
          revision: 'v1',
        })
        await attemptExecutor.ack(versionedClaim!)

        const taskCommand = {
          ...attempt(),
          kind: 'taskAttempt' as const,
          workflowName: name,
          taskName: name,
          revision: 'v1',
        }
        await attemptExecutor.dispatchTask(taskCommand)
        const claimTask = (revision?: string) =>
          attemptExecutor.claim({
            ...worker,
            workflows: [],
            tasks: [{ name, ...(revision === undefined ? {} : { revision }) }],
          })
        expect(await claimTask()).toBeNull()
        expect(await claimTask('v2')).toBeNull()
        expect((await claimTask('v1'))?.command).toMatchObject({
          attemptId: taskCommand.attemptId,
          revision: 'v1',
        })
      })

      it('resumes a crashed delivery only on a worker serving its revision', async () => {
        const prefix = unique('crash')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        // The only v1 coordinator claims the continuation and dies.
        const claimed = await runtime.runCoordinationExecutor.claim({
          workerId: 'crashed',
          workflows: [{ name: v1.parent.name, revision: 'v1' }],
          leaseMs: 1,
        })
        expect(claimed).not.toBeNull()
        await wait(20)

        expect(await drain(runtime, serve(v2))).toBe(0)
        expect((await client.get(run.id))!.run.status).toBe('queued')
        expect(await client.listDeadCommands({ runId: run.id })).toHaveLength(0)

        await drain(runtime, serve(v1))
        expect((await client.get(run.id))!.run.status).toBe('completed')
      })
    })

    describe('saved definitions', () => {
      it('rejects another graph under a revision that is already saved', async () => {
        const prefix = unique('graphdrift')
        const v1 = deploy(prefix, 'v1')
        const drifted = reshape(prefix, 'v1')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        await expect(client.start(drifted.parent, 'x')).rejects.toThrow(
          WorkflowDefinitionConflictError,
        )

        const { runs } = await client.list({ name: v1.parent.name })
        expect(runs.map(({ id }) => id)).toStrictEqual([run.id])
        expect(await client.getDefinition(refOf(v1.parent))).toMatchObject({
          graph: { structure: projectStructure(v1.parent) },
        })
      })

      it('rejects other child revisions under a revision that is already saved', async () => {
        const prefix = unique('binddrift')
        const parentOf = (taskRevision: string) => {
          const task = defineTask({
            name: `${prefix}.task`,
            revision: taskRevision,
            input: text,
            output: text,
          })
          return defineWorkflow({
            name: `${prefix}.parent`,
            revision: 'p1',
            input: text,
            output: text,
          })
            .task('work', task)
            .build()
        }
        const original = parentOf('t1')
        const rebound = parentOf('t2')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        // Same topology, so the same graph hash: only the manifest tells.
        expect(describeDefinition(rebound).graphHash).toBe(
          describeDefinition(original).graphHash,
        )
        await client.start(original, 'x')
        await expect(client.start(rebound, 'x')).rejects.toThrow(
          'already saved with a different graph or different child revisions',
        )
        expect((await client.list({ name: original.name })).runs).toHaveLength(
          1,
        )
        expect(
          await client.getDefinition({
            kind: 'task',
            name: `${prefix}.task`,
            revision: 't2',
          }),
        ).toBeUndefined()
      })

      it('accepts a relabelled definition and keeps the labels of older runs', async () => {
        const prefix = unique('labels')
        const before = deploy(prefix, 'v1', { title: 'Before' })
        const after = deploy(prefix, 'v1', { title: 'After' })
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const older = await client.start(before.parent, 'x')
        const newer = await client.start(after.parent, 'y')

        expect(newer.graphHash).toBe(older.graphHash)
        const [olderView, newerView] = await Promise.all([
          client.inspect(older.id),
          client.inspect(newer.id),
        ])
        expect(olderView!.definition).toMatchObject({
          source: 'saved',
          presentation: captureGraphPresentation(before.parent),
        })
        expect(newerView!.definition).toMatchObject({
          source: 'saved',
          presentation: captureGraphPresentation(after.parent),
        })
      })

      it('hands out copies of what is saved', async () => {
        const prefix = unique('immutable')
        const v1 = deploy(prefix, 'v1', { title: 'Title' })
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        const run = await client.start(v1.parent, 'x')
        const ref = refOf(v1.parent)

        const graph = (await runtime.store.loadGraph(run.graphHash!))!
        const manifest = (await runtime.store.loadRevision(ref))!
        const labels = (await runtime.store.loadGraphPresentation(run.id))!
        ;(graph.structure as { name: string }).name = 'mutated'
        ;(manifest.bindings as unknown[]).length = 0
        ;(labels as { title: string }).title = 'mutated'

        expect(
          (await runtime.store.loadGraph(run.graphHash!))!.structure,
        ).toStrictEqual(projectStructure(v1.parent))
        expect(await runtime.store.loadRevision(ref)).toStrictEqual(
          describeDefinition(v1.parent).manifest,
        )
        expect(await runtime.store.loadGraphPresentation(run.id)).toStrictEqual(
          captureGraphPresentation(v1.parent),
        )
      })

      it('refuses a run that names definitions nobody saved', async () => {
        const prefix = unique('missing')
        const v1 = deploy(prefix, 'v1')
        const runtime = await createRuntime()
        const { definitions: _definitions, ...identity } = runDefinitionInput(
          v1.parent,
        )
        const input = { workflowName: v1.parent.name, input: 'x' }

        await expect(
          runtime.store.createRun({ ...input, ...identity }),
        ).rejects.toThrow(WorkflowDefinitionConflictError)
        await expect(
          runtime.store.createRun({ ...input, executionRevision: 'v1' }),
        ).rejects.toThrow('needs a graph hash')
        expect(
          (await runtime.store.listRuns({ name: v1.parent.name })).runs,
        ).toHaveLength(0)
      })
    })

    describe('definition drift on a worker', () => {
      it('dead-letters a continuation whose registered graph differs and fails the run', async () => {
        const prefix = unique('workerdrift')
        const v1 = deploy(prefix, 'v1')
        const drifted = reshape(prefix, 'v1')
        const runtime = await createRuntime({ maxDeliveries: 1 })
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        expect(await drain(runtime, serve(drifted))).toBe(0)

        const before = (await client.get(run.id))!
        expect(before.nodes).toHaveLength(0)
        const [dead] = await client.listDeadCommands({ runId: run.id })
        expect(dead).toMatchObject({
          kind: 'continue',
          lastError: { name: 'WorkflowDefinitionConflictError' },
        })

        await reapDeadWorkflowCommands({ ...runtime, ...serve(drifted) })
        const failed = (await client.get(run.id))!.run
        expect(failed.status).toBe('failed')
        expect(failed.error).toMatchObject({
          name: 'WorkflowDefinitionConflictError',
        })
        expect(failed.error?.message).toContain(
          `workflow [${v1.parent.name}@v1]`,
        )
      })

      it('never runs an activity handler of a drifted workflow', async () => {
        const prefix = unique('activitydrift')
        const v1 = deploy(prefix, 'v1')
        const drifted = reshape(prefix, 'v1')
        const runtime = await createRuntime({ maxDeliveries: 1 })
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        await runWorkflowWorker({
          ...runtime,
          ...quiet,
          workflows: v1.workflows,
          workerId: 'coordinator',
        })
        const execution = await runExecutionWorker({
          ...runtime,
          reaping: false,
          ...serve(drifted),
          workerId: 'execution',
        })
        expect(execution.processed).toBe(0)
        expect((await client.get(run.id))!.attempts).toMatchObject([
          { status: 'started' },
        ])

        await reapDeadWorkflowCommands({ ...runtime, ...serve(v1) })
        await drain(runtime, serve(v1))
        const failed = (await client.get(run.id))!
        expect(failed.run.status).toBe('failed')
        expect(failed.run.error).toMatchObject({
          name: 'WorkflowDefinitionConflictError',
        })
        // Nothing past the drifted activity was ever created.
        expect(failed.nodes.map(({ name }) => name)).toStrictEqual(['first'])
      })

      it('fails a run whose registered child bindings differ', async () => {
        const prefix = unique('workerbind')
        const build = (taskRevision: string) => {
          const task = defineTask({
            name: `${prefix}.task`,
            revision: taskRevision,
            input: text,
            output: text,
          })
          const parent = defineWorkflow({
            name: `${prefix}.parent`,
            revision: 'p1',
            input: text,
            output: text,
          })
            .task('work', task)
            .build()
          const implementation = implementWorkflow(parent, { pool: 'test' })
            .work(task)
            .finish(({ work }) => work)
          const taskImplementation = implementTask(task, {
            pool: 'test',
            handler: async (input) => `${input}|${taskRevision}`,
          })
          return {
            parent,
            workflows: [implementation],
            tasks: [taskImplementation],
          }
        }
        const original = build('t1')
        const rebound = build('t2')
        const runtime = await createRuntime({ maxDeliveries: 1 })
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(original.parent, 'x')
        expect(await drain(runtime, rebound)).toBe(0)
        await reapDeadWorkflowCommands({ ...runtime, ...rebound })

        const failed = (await client.get(run.id))!
        expect(failed.run.status).toBe('failed')
        expect(failed.run.error?.message).toContain(
          'binds different child revisions than its saved manifest',
        )
        expect(await client.getFamily(run.id)).toHaveLength(1)
      })
    })

    describe('idempotency and uniqueness', () => {
      it('replays a key for the same revision and conflicts for another', async () => {
        const prefix = unique('idem')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        const idempotencyKey = [prefix, 'order-1']

        const first = await client.start(v1.parent, 'x', { idempotencyKey })
        const replay = await client.start(v1.parent, 'x', { idempotencyKey })
        expect(replay.id).toBe(first.id)

        const conflict = await client
          .start(v2.parent, 'x', { idempotencyKey })
          .catch((error: unknown) => error)
        expect(conflict).toBeInstanceOf(WorkflowIdempotencyConflictError)
        expect(conflict).toMatchObject({ runId: first.id })
        expect((await client.list({ name: v1.parent.name })).runs).toHaveLength(
          1,
        )
      })

      it('replays an unversioned key whatever the graph has become', async () => {
        const prefix = unique('idemlegacy')
        const legacy = deploy(prefix, undefined)
        const reshaped = reshape(prefix, undefined)
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        const idempotencyKey = [prefix, 'order-1']

        const first = await client.start(legacy.parent, 'x', { idempotencyKey })
        // Unversioned code changes under its name between deployments; the
        // key keeps naming the run it created, as it always did.
        const replay = await client.start(reshaped.parent, 'x', {
          idempotencyKey,
        })

        expect(replay.id).toBe(first.id)
        expect(replay.graphHash).toBe(first.graphHash)
      })

      it('joins a unique key only as the same workflow and revision', async () => {
        const prefix = unique('join')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const legacy = deploy(prefix, undefined)
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        const join = { key: [prefix, 'tenant'], behavior: 'join' } as const

        const holder = await client.start(v1.parent, 'x', { unique: join })
        expect((await client.start(v1.parent, 'y', { unique: join })).id).toBe(
          holder.id,
        )

        for (const definition of [v2.parent, legacy.parent]) {
          const conflict = await client
            .start(definition, 'x', { unique: join })
            .catch((error: unknown) => error)
          expect(conflict).toBeInstanceOf(WorkflowRunConflictError)
          expect(conflict).toMatchObject({
            runId: holder.id,
            holder: { kind: 'workflow', name: v1.parent.name, revision: 'v1' },
          })
        }

        const rejected = await client
          .start(v2.parent, 'x', { unique: { key: join.key } })
          .catch((error: unknown) => error)
        expect(rejected).toBeInstanceOf(WorkflowRunConflictError)
        expect(rejected).toMatchObject({ runId: holder.id })
        expect((rejected as WorkflowRunConflictError).holder).toBeUndefined()
        // The key stays global: no second live run exists under it.
        expect((await client.list({ name: v1.parent.name })).runs).toHaveLength(
          1,
        )
      })

      it('joins two unversioned runs as before, whatever they are', async () => {
        const prefix = unique('joinlegacy')
        const legacy = deploy(prefix, undefined)
        const other = defineWorkflow({
          name: `${prefix}.other`,
          input: text,
          output: z.array(text),
        }).build()
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        const join = { key: [prefix, 'tenant'], behavior: 'join' } as const

        const holder = await client.start(legacy.parent, 'x', { unique: join })
        const joined = await client.start(other, 'x', { unique: join })

        expect(joined.id).toBe(holder.id)
      })
    })

    describe('restart and retry', () => {
      it('restarts with the original revision by default and the configured current on request', async () => {
        const prefix = unique('restart')
        // Lexically inverted on purpose: nothing may be inferred from order.
        const older = deploy(prefix, 'b-older')
        const newer = deploy(prefix, 'a-newer')
        const legacy = deploy(prefix, undefined)
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient({
          ...runtime,
          definitions: [older.parent, legacy.parent],
          current: [newer.parent],
        })
        const served = serve(older, newer, legacy)

        const run = await client.start(older.parent, 'x')
        const loose = await client.start(legacy.parent, 'x')
        await drain(runtime, served)

        expect((await client.restart(run.id)).executionRevision).toBe('b-older')
        expect(
          (await client.restart(run.id, { revision: 'latest' }))
            .executionRevision,
        ).toBe('a-newer')
        expect(
          (await client.restart(loose.id)).executionRevision,
        ).toBeUndefined()
        expect(
          (await client.restart(loose.id, { revision: 'latest' }))
            .executionRevision,
        ).toBe('a-newer')
      })

      it('fails a restart whose original definition is unknown', async () => {
        const prefix = unique('restartunknown')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()
        const run = await createWorkflowRuntimeClient(runtime).start(
          v1.parent,
          'x',
        )
        await drain(runtime, serve(v1))
        const withoutOriginal = createWorkflowRuntimeClient({
          ...runtime,
          definitions: [v2.parent],
        })

        await expect(withoutOriginal.restart(run.id)).rejects.toThrow(
          `no workflow definition [${v1.parent.name}@v1] is known to this client`,
        )
        // Listing v2 does not make it current: that takes `current`.
        await expect(
          withoutOriginal.restart(run.id, { revision: 'latest' }),
        ).rejects.toThrow(
          `no current workflow [${v1.parent.name}] is configured`,
        )
        expect(
          (await withoutOriginal.list({ name: v1.parent.name })).runs,
        ).toHaveLength(1)
      })

      it('creates nothing when the stored input does not fit the latest schema', async () => {
        const name = unique('restartschema')
        const v1 = defineWorkflow({ name, revision: 'v1', input: text }).build()
        const v2 = defineWorkflow({
          name,
          revision: 'v2',
          input: z.object({ scenario: z.string() }),
        }).build()
        const implementation = implementWorkflow(v1, { pool: 'test' }).finish(
          () => undefined,
        )
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient({
          ...runtime,
          definitions: [v1],
          current: [v2],
        })

        const run = await client.start(v1, 'x')
        await drain(runtime, { workflows: [implementation], tasks: [] })

        await expect(
          client.restart(run.id, { revision: 'latest' }),
        ).rejects.toThrow()
        expect((await client.list({ name })).runs).toHaveLength(1)
        expect((await client.restart(run.id)).executionRevision).toBe('v1')
      })

      it('refuses two current definitions of one name', async () => {
        const prefix = unique('current')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()

        expect(() =>
          createWorkflowRuntimeClient({
            ...runtime,
            current: [v1.parent, v2.parent],
          }),
        ).toThrow(`More than one current workflow [${v1.parent.name}]`)
      })

      it('retries a failed run in place without changing what it is pinned to', async () => {
        const name = unique('retry')
        let healthy = false
        const workflow = defineWorkflow({
          name,
          revision: 'v1',
          input: text,
          output: text,
        })
          .activity('step', { input: text, output: text })
          .build()
        const implementation = implementWorkflow(workflow, { pool: 'test' })
          .step(async (input) => {
            if (!healthy) throw new Error('not yet')
            return input
          })
          .finish(({ step }) => step)
        const served = { workflows: [implementation], tasks: [] }
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(workflow, 'x')
        await drain(runtime, served)
        expect((await client.get(run.id))!.run.status).toBe('failed')

        healthy = true
        const reopened = await client.retry(run.id)
        expect(reopened).toMatchObject({
          id: run.id,
          executionRevision: 'v1',
          graphHash: run.graphHash,
        })
        // A legacy-lane worker of the same name must not pick the retry up.
        const unversioned = implementWorkflow(
          defineWorkflow({ name, input: text, output: text })
            .activity('step', { input: text, output: text })
            .build(),
          { pool: 'test' },
        )
          .step(async () => 'wrong code')
          .finish(({ step }) => step)
        expect(
          await drain(runtime, { workflows: [unversioned], tasks: [] }),
        ).toBe(0)

        await drain(runtime, served)
        const settled = (await client.get(run.id))!.run
        expect(settled).toMatchObject({
          status: 'completed',
          output: 'x',
          executionRevision: 'v1',
        })
      })
    })

    describe('inspection', () => {
      it('returns the saved graph, labels and bindings of a run', async () => {
        const prefix = unique('inspect')
        const v1 = deploy(prefix, 'v1', { title: 'Saved' })
        const runtime = await createRuntime()
        const run = await createWorkflowRuntimeClient(runtime).start(
          v1.parent,
          'x',
        )
        await drain(runtime, serve(v1))
        // Built from the adapter alone: no definition or implementation.
        const inspector = createWorkflowRuntimeClient(runtime)

        const inspection = (await inspector.inspect(run.id))!
        const { structure, graphHash, presentation, manifest } =
          describeDefinition(v1.parent)
        expect(inspection.detail.run).toMatchObject({
          id: run.id,
          status: 'completed',
          executionRevision: 'v1',
        })
        expect(inspection.definition).toStrictEqual({
          source: 'saved',
          graphHash,
          structure,
          presentation,
          revision: manifest,
        })

        // A child shows its own graph and labels, not its parent's.
        const child = inspection.detail.childRuns.find(
          ({ name }) => name === v1.child.name,
        )!
        expect((await inspector.inspect(child.id))!.definition).toMatchObject({
          source: 'saved',
          structure: projectStructure(v1.child),
          presentation: captureGraphPresentation(v1.child),
        })
        expect(await inspector.inspect('missing-run')).toBeUndefined()
      })

      it('previews a branch alternative the run never took', async () => {
        const prefix = unique('preview')
        const v1 = deploy(prefix, 'v1')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)
        // Started, never executed: no child run of any kind exists.
        const run = await client.start(v1.parent, 'x')

        const inspection = (await client.inspect(run.id))!
        if (inspection.definition.source !== 'saved') {
          throw new Error('Expected a saved definition')
        }
        const binding = inspection.definition.revision!.bindings.find(
          ({ nodeName, caseKey }) =>
            nodeName === 'route' && caseKey === 'viaChild',
        )!

        expect(await client.getDefinition(binding.target)).toStrictEqual({
          revision: describeDefinition(v1.child).manifest,
          graph: {
            graphHash: describeDefinition(v1.child).graphHash,
            structure: projectStructure(v1.child),
          },
        })
        expect(
          await client.getDefinition({ ...binding.target, revision: 'v9' }),
        ).toBeUndefined()
      })

      it('reports a run without a saved graph as observed only', async () => {
        const prefix = unique('observed')
        const legacy = deploy(prefix, undefined, { title: 'Today' })
        const runtime = await createRuntime()
        // What a run created before graphs were saved looks like.
        const run = await runtime.store.createRun({
          workflowName: legacy.parent.name,
          input: 'x',
        })
        await runtime.runCoordinationExecutor.enqueue(continueRunCommand(run))
        await drain(runtime, serve(legacy))
        // The client knows today's definition and must not use it.
        const client = createWorkflowRuntimeClient({
          ...runtime,
          ...serve(legacy),
        })

        const inspection = (await client.inspect(run.id))!
        expect(inspection.definition).toStrictEqual({
          source: 'observed',
          reason: 'legacy',
        })
        expect(inspection.detail.run.status).toBe('completed')
        expect(inspection.detail.nodes).toHaveLength(6)
      })

      it('saves a graph for new unversioned runs without pinning them', async () => {
        const prefix = unique('unversioned')
        const legacy = deploy(prefix, undefined, { title: 'Then' })
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(legacy.parent, 'x')

        expect((await client.inspect(run.id))!.definition).toStrictEqual({
          source: 'saved',
          graphHash: run.graphHash,
          structure: projectStructure(legacy.parent),
          presentation: captureGraphPresentation(legacy.parent),
        })
      })
    })

    describe('retention', () => {
      it('keeps shared definitions when the runs that used them are deleted', async () => {
        const prefix = unique('retention')
        const v1 = deploy(prefix, 'v1', { title: 'Kept' })
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const deleted = await client.start(v1.parent, 'x')
        const kept = await client.start(v1.parent, 'y')
        await drain(runtime, serve(v1))
        expect(await client.deleteRun(deleted.id)).toStrictEqual({
          deleted: true,
        })

        expect(
          await runtime.store.loadGraphPresentation(deleted.id),
        ).toBeUndefined()
        expect((await client.inspect(kept.id))!.definition).toMatchObject({
          source: 'saved',
          revision: describeDefinition(v1.parent).manifest,
        })

        // Even with no run left, the revision stays immutable and readable.
        await client.deleteRun(kept.id)
        expect(await client.getDefinition(refOf(v1.parent))).toBeDefined()
        expect(await client.getDefinition(refOf(v1.child))).toBeDefined()
        await expect(
          client.start(reshape(prefix, 'v1').parent, 'x'),
        ).rejects.toThrow(WorkflowDefinitionConflictError)
      })
    })

    describe('timeouts and cancellation', () => {
      it('sweeps a run only with the timeout of the revision it runs', async () => {
        const prefix = unique('timeout')
        const brief = deploy(prefix, 'v1', { timeout: '20ms' })
        const patient = deploy(prefix, 'v2', { timeout: '1h' })
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const expiring = await client.start(brief.parent, 'x')
        const waiting = await client.start(patient.parent, 'x')
        await wait(40)

        // A coordinator that does not serve v1 has no policy to apply to it.
        expect(
          await timeoutExpiredWorkflowRuns({
            ...runtime,
            workflows: patient.workflows,
          }),
        ).toStrictEqual({ timedOut: 0 })
        expect((await client.get(expiring.id))!.run.status).toBe('queued')

        expect(
          await timeoutExpiredWorkflowRuns({
            ...runtime,
            workflows: serve(brief, patient).workflows,
          }),
        ).toStrictEqual({ timedOut: 1 })
        expect((await client.get(expiring.id))!.run.status).toBe('failed')
        expect((await client.get(waiting.id))!.run.status).toBe('queued')
      })

      it('settles a cancelled workflow run once its revision is served', async () => {
        const prefix = unique('cancel')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.parent, 'x')
        expect((await client.cancel(run.id))!.status).toBe('cancelling')
        expect(await drain(runtime, serve(v2))).toBe(0)
        expect((await client.get(run.id))!.run.status).toBe('cancelling')

        // The drifted registration still settles it: cancellation walks
        // stored state and needs no code of the run.
        await drain(runtime, serve(reshape(prefix, 'v1')))
        expect((await client.get(run.id))!.run.status).toBe('cancelled')
      })

      it('cancels a task run of an unserved revision at once', async () => {
        const prefix = unique('canceltask')
        const v1 = deploy(prefix, 'v1')
        const runtime = await createRuntime()
        const client = createWorkflowRuntimeClient(runtime)

        const run = await client.start(v1.task, 'x')

        expect((await client.cancel(run.id))!.status).toBe('cancelled')
      })
    })

    // Skipped per test for adapters without a scheduler.
    describe('schedules', () => {
      it('pins every fire to the revision it was reconciled with', async (context) => {
        const prefix = unique('schedule')
        const v1 = deploy(prefix, 'v1')
        const runtime = await createRuntime()
        const { scheduler } = runtime
        if (!scheduler) return context.skip()
        const client = createWorkflowRuntimeClient(runtime)
        const name = `${prefix}.nightly`

        await scheduler.reconcile([
          defineSchedule({
            name,
            runnable: v1.parent,
            input: 'x',
            every: '1h',
          }),
        ])
        const [stored] = await scheduler.list()
        expect(stored).toMatchObject({
          name,
          executionRevision: 'v1',
          graphHash: describeDefinition(v1.parent).graphHash,
        })
        // Reconciling saved the definitions: no start ever ran here.
        expect(await client.getDefinition(refOf(v1.child))).toBeDefined()

        await scheduler.fireDue({ now: stored!.nextRunAt })
        const { runs } = await client.list({ tags: { schedule: name } })
        expect(runs).toMatchObject([{ executionRevision: 'v1' }])
        expect((await client.inspect(runs[0]!.id))!.definition.source).toBe(
          'saved',
        )

        const manual = await scheduler.trigger(name)
        expect(manual.executionRevision).toBe('v1')
      })

      it('adopts the run of a slot that crashed before acknowledgement, across a deployment', async (context) => {
        const prefix = unique('slot')
        const v1 = deploy(prefix, 'v1')
        const v2 = deploy(prefix, 'v2')
        const runtime = await createRuntime()
        const { scheduler } = runtime
        if (!scheduler) return context.skip()
        const client = createWorkflowRuntimeClient(runtime)
        const name = `${prefix}.nightly`
        const schedule = (runnable: typeof v1.parent, input: string) =>
          defineSchedule({ name, runnable, input, every: '1h' })

        await scheduler.reconcile([schedule(v1.parent, 'before')])
        const [stored] = await scheduler.list()
        const slot = stored!.nextRunAt
        // The fire created the slot's run and died before recording it.
        const orphan = await startStoredScheduleRun(runtime, stored!, slot)
        expect((await scheduler.list())[0]!.nextRunAt).toBe(slot)

        // The next deployment changes both the revision and the input.
        await scheduler.reconcile([schedule(v2.parent, 'after')])
        expect(await scheduler.fireDue({ now: slot })).toStrictEqual({
          fired: 1,
        })

        const slotRuns = async () =>
          (await client.list({ tags: { schedule: name } })).runs
        expect(await slotRuns()).toMatchObject([
          { id: orphan.id, executionRevision: 'v1', input: 'before' },
        ])
        const [acknowledged] = await scheduler.list()
        expect(acknowledged!.lastSlotAt).toBe(slot)
        expect(acknowledged!.nextRunAt).toBeGreaterThan(slot)

        // The adopted run is dispatched as what it is, and completes on v1.
        await drain(runtime, serve(v1, v2))
        expect((await client.get(orphan.id))!.run.status).toBe('completed')

        await scheduler.fireDue({ now: acknowledged!.nextRunAt })
        const runs = await slotRuns()
        expect(runs).toHaveLength(2)
        expect(runs.find(({ id }) => id !== orphan.id)).toMatchObject({
          executionRevision: 'v2',
          input: 'after',
        })
      })
    })
  })
}
