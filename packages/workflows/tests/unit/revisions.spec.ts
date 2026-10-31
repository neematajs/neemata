import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import * as TestClock from 'effect/testing/TestClock'

import type {
  AnyTask,
  Definition,
  RevisionManifest,
  ServedWorkflow,
  Snapshot,
} from '../../src/index.ts'
import {
  captureGraphPresentation,
  Client,
  describeDefinition,
  projectStructure,
  start,
  Store,
  task,
  workflow,
} from '../../src/index.ts'
import { coordinate, deployment, execute, serve } from '../typed-support.ts'

const text = Schema.String
const pool = 'test'

type Served = {
  readonly workflows: readonly ServedWorkflow[]
  readonly tasks: readonly AnyTask[]
}

/**
 * One deployed generation of a small family: a task, a child workflow and a
 * parent using every node kind. Each handler stamps its own revision into its
 * output, so a run's result proves which code ran it.
 */
function deploy(prefix: string, revision?: string, title?: string) {
  const tag = revision ?? 'legacy'
  const labels = title === undefined ? {} : { title }
  const stamp = (place: string) => (input: string) =>
    Effect.succeed(`${input}|${place}@${tag}`)
  const io = { input: text, output: text }

  const Task = task({
    ...io,
    ...labels,
    name: `${prefix}.task`,
    revision,
    pool,
    handler: stamp('task'),
  })
  const Child = workflow(
    { ...io, ...labels, name: `${prefix}.child`, revision, pool },
    function* (w) {
      return yield* w.activity('step', {
        ...io,
        ...labels,
        from: w.input,
        handler: stamp('child'),
      })
    },
  )
  const Parent = workflow(
    {
      ...labels,
      name: `${prefix}.parent`,
      revision,
      pool,
      input: text,
      output: Schema.Array(text),
    },
    function* (w) {
      const input = w.input
      const first = yield* w.activity('first', {
        ...io,
        ...labels,
        from: input,
        handler: stamp('first'),
      })
      const work = yield* w.task('work', Task, { ...labels, input })
      const route = yield* w.branch('route', {
        ...labels,
        select: Effect.map(input, (value) =>
          value.startsWith('child') ? 'viaChild' : 'viaTask',
        ),
        cases: (p) => ({
          viaTask: p.task(Task, { ...labels, input }),
          viaChild: p.workflow(Child, { ...labels, input }),
        }),
      })
      const both = yield* w.parallel('both', {
        members: (p) => ({
          left: p.task(Task, { input }),
          right: p.workflow(Child, { input }),
          inline: p.activity({ ...io, from: input, handler: stamp('inline') }),
        }),
      })
      const each = yield* w.mapTask('each', Task, {
        item: text,
        items: Effect.succeed(['a', 'b']),
        input: (item) => Effect.succeed(item),
      })
      const eachChild = yield* w.mapWorkflow('eachChild', Child, {
        item: text,
        items: Effect.succeed(['c']),
        input: (item) => Effect.succeed(item),
      })

      return Effect.gen(function* () {
        const { left, right, inline } = yield* both
        return [
          yield* first,
          yield* work,
          yield* route,
          left,
          right,
          inline,
          ...(yield* each).items.map(({ output }) => output),
          ...(yield* eachChild).items.map(({ output }) => output),
        ]
      })
    },
  )

  return { tag, Task, Child, Parent, workflows: [Parent, Child], tasks: [Task] }
}

/**
 * The parent of `deploy` under the same name and revision with another graph:
 * what editing a workflow in place without a new revision looks like.
 */
function reshape(prefix: string, revision?: string) {
  const seen = { ran: 0 }
  const Parent = workflow(
    {
      name: `${prefix}.parent`,
      revision,
      pool,
      input: text,
      output: Schema.Array(text),
    },
    function* (w) {
      const first = yield* w.activity('first', {
        input: text,
        output: text,
        from: w.input,
        handler: (input) =>
          Effect.sync(() => {
            seen.ran += 1
            return `${input}|reshaped`
          }),
      })
      return Effect.map(first, (value) => [value])
    },
  )

  return { seen, Parent, workflows: [Parent], tasks: [] }
}

/** A parent of one task step, the task at a revision of its own. */
function bound(prefix: string, taskRevision: string) {
  const Task = task({
    name: `${prefix}.task`,
    revision: taskRevision,
    pool,
    input: text,
    output: text,
    handler: (input) => Effect.succeed(`${input}|${taskRevision}`),
  })
  const Parent = workflow(
    {
      name: `${prefix}.parent`,
      revision: 'p1',
      pool,
      input: text,
      output: text,
    },
    function* (w) {
      return yield* w.task('work', Task, { input: w.input })
    },
  )

  return { Task, Parent, workflows: [Parent], tasks: [Task] }
}

const all = (...deployments: readonly Served[]): Served => ({
  workflows: deployments.flatMap(({ workflows }) => workflows),
  tasks: deployments.flatMap(({ tasks }) => tasks),
})

const refOf = ({ kind, name, revision }: Definition) => ({
  kind,
  name,
  revision: revision!,
})

const stored = (runId: string) =>
  Effect.map(Client.get(runId), (records) => records!)

const status = (runId: string) =>
  Effect.map(stored(runId), ({ run }) => run.status)

describe('pinning', () => {
  it.effect(
    'pins a run to the revision of the declaration it was started from',
    () => {
      const v1 = deploy('pin', 'v1')
      const legacy = deploy('pin')
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const pinned = yield* Client.start(v1.Parent, 'x')
          const loose = yield* Client.start(legacy.Parent, 'x')

          expect(pinned.revision).toBe('v1')
          expect(pinned.graphHash).toBe(describeDefinition(v1.Parent).graphHash)
          expect(loose).not.toHaveProperty('revision')
          // Topology is the same, so the hash is; the revision is what differs.
          expect(loose.graphHash).toBe(pinned.graphHash)

          expect((yield* stored(pinned.id)).run).toMatchObject({
            revision: 'v1',
            graphHash: pinned.graphHash,
          })
        }),
      )
    },
  )

  it.effect(
    'keeps every child of a v1 parent on v1 after v2 is deployed',
    () => {
      const v1 = deploy('family', 'v1')
      const v2 = deploy('family', 'v2')
      const { provide, inspect } = deployment()

      return provide(
        Effect.gen(function* () {
          const viaTask = yield* Client.start(v1.Parent, 'x')
          const viaChild = yield* Client.start(v1.Parent, 'child-y')
          // One pass under v1 alone: only the first activity exists so far,
          // every child is created after v2 is deployed.
          yield* coordinate(v1.workflows)
          expect(inspect.runs()).toHaveLength(2)
          const next = yield* Client.start(v2.Parent, 'x')
          yield* serve(all(v1, v2))

          for (const [run, tag] of [
            [viaTask, 'v1'],
            [viaChild, 'v1'],
            [next, 'v2'],
          ] as const) {
            const { status, output } = (yield* stored(run.id)).run
            expect(status).toBe('completed')
            expect(output).toHaveLength(9)
            for (const line of output as string[]) {
              expect(line.endsWith(`@${tag}`)).toBe(true)
            }

            const family = inspect
              .runs()
              .filter((member) => member.run.rootRunId === run.id)
            // parent + work + route + both.left + both.right + each×2 + eachChild
            expect(family).toHaveLength(8)
            for (const member of family) {
              expect(member.run.revision).toBe(tag)
              expect(member.run.graphHash).toBeDefined()
            }
          }
          expect(((yield* stored(viaChild.id)).run.output as string[])[2]).toBe(
            'child-y|child@v1',
          )
        }),
      )
    },
  )

  it.effect('lets an unversioned parent run versioned children', () => {
    const v1 = deploy('mixed', 'v1')
    const Loose = workflow(
      { name: 'mixed.loose', pool, input: text, output: text },
      function* (w) {
        return yield* w.workflow('sub', v1.Child, { input: w.input })
      },
    )
    const { provide, inspect } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Loose, 'x')
        // Nothing pins what an unversioned run references, so nothing of the
        // child was saved when the root started.
        expect(yield* Client.getDefinition(refOf(v1.Child))).toBeUndefined()

        yield* serve(all(v1, { workflows: [Loose], tasks: [] }))

        const [parent, child] = inspect.runs()
        expect(parent!.run).toMatchObject({ id: run.id, status: 'completed' })
        expect(parent!.run).not.toHaveProperty('revision')
        // The child brought its own definitions when it was created.
        expect(child!.run).toMatchObject({
          revision: 'v1',
          graphHash: describeDefinition(v1.Child).graphHash,
        })
        expect(yield* Client.getDefinition(refOf(v1.Child))).toMatchObject({
          graph: { structure: projectStructure(v1.Child) },
        })
      }),
    )
  })
})

describe('routing', () => {
  it.effect('leaves work of an unserved revision queued and untouched', () => {
    const v1 = deploy('parked', 'v1')
    const v2 = deploy('parked', 'v2')
    const legacy = deploy('parked')
    const { provide, inspect } = deployment({ maxDeliveries: 2 })

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(v1.Parent, 'x')
        yield* serve(all(v2, legacy))

        // Never claimed, so never counted: even a delivery budget of two is
        // not spent by workers that cannot run it.
        expect(yield* status(run.id)).toBe('queued')
        expect(inspect.queue()).toMatchObject([{ deliveries: 0 }])
        expect(inspect.dead()).toHaveLength(0)

        yield* serve(v1)
        expect(yield* status(run.id)).toBe('completed')
      }),
    )
  })

  it.effect(
    'parks a run mid-flight when its revision stops being served',
    () => {
      const v1 = deploy('midflight', 'v1')
      const v2 = deploy('midflight', 'v2')
      const { provide, inspect } = deployment({ maxDeliveries: 2 })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(v1.Parent, 'x')
          yield* coordinate(v1.workflows)
          // The first activity is dispatched; only v2 code is running now.
          yield* serve(v2)

          const parked = yield* stored(run.id)
          expect(parked.run.status).toBe('running')
          expect(parked.attempts).toMatchObject([{ status: 'started' }])
          expect(inspect.dead()).toHaveLength(0)

          yield* serve(v1)
          expect(yield* status(run.id)).toBe('completed')
        }),
      )
    },
  )

  it.effect('keeps the unversioned lane and versioned lanes apart', () => {
    const v1 = deploy('lanes', 'v1')
    const legacy = deploy('lanes')
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const loose = yield* Client.start(legacy.Parent, 'x')
        const pinned = yield* Client.start(v1.Parent, 'x')

        yield* serve(v1)
        expect(yield* status(pinned.id)).toBe('completed')
        expect(yield* status(loose.id)).toBe('queued')

        yield* serve(legacy)
        const settled = (yield* stored(loose.id)).run
        expect(settled.status).toBe('completed')
        for (const line of settled.output as string[]) {
          expect(line.endsWith('@legacy')).toBe(true)
        }
      }),
    )
  })

  it.effect(
    'resumes a crashed delivery only on a worker serving its revision',
    () => {
      const v1 = deploy('crash', 'v1')
      const v2 = deploy('crash', 'v2')
      const { provide, inspect } = deployment()

      return provide(
        Effect.gen(function* () {
          const store = yield* Store
          const run = yield* Client.start(v1.Parent, 'x')
          // The only v1 coordinator claims the continuation and dies.
          const claimed = yield* store.claim({
            lanes: [
              {
                kind: 'continueRun',
                routes: [{ name: v1.Parent.name, revision: 'v1' }],
              },
            ],
            limit: 1,
            leaseMs: 1,
          })
          expect(claimed).toHaveLength(1)
          yield* TestClock.adjust(20)

          yield* serve(v2)
          expect(yield* status(run.id)).toBe('queued')
          expect(inspect.dead()).toHaveLength(0)

          yield* serve(v1)
          expect(yield* status(run.id)).toBe('completed')
        }),
      )
    },
  )
})

describe('saved definitions', () => {
  it.effect(
    'rejects another graph under a revision that is already saved',
    () => {
      const v1 = deploy('graphdrift', 'v1')
      const drifted = reshape('graphdrift', 'v1')
      const { provide, inspect } = deployment()

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(v1.Parent, 'x')
          const saved = new Map(inspect.definitions())

          const refused = yield* Effect.flip(Client.start(drifted.Parent, 'x'))
          expect(refused).toMatchObject({
            _tag: 'DefinitionConflict',
            message:
              'workflow [graphdrift.parent@v1] is already saved with a different graph or different child revisions; a changed definition needs a new revision',
          })

          expect(inspect.runs().map((member) => member.run.id)).toStrictEqual([
            run.id,
          ])
          expect(inspect.queue()).toHaveLength(1)
          // The drifted graph itself was new, and was not saved either.
          expect(inspect.definitions()).toStrictEqual(saved)
          expect(yield* Client.getDefinition(refOf(v1.Parent))).toMatchObject({
            graph: { structure: projectStructure(v1.Parent) },
          })
        }),
      )
    },
  )

  it.effect(
    'rejects other child revisions under a revision that is already saved',
    () => {
      const original = bound('binddrift', 't1')
      const rebound = bound('binddrift', 't2')
      const { provide, inspect } = deployment()

      // Same topology, so the same graph hash: only the manifest tells.
      expect(describeDefinition(rebound.Parent).graphHash).toBe(
        describeDefinition(original.Parent).graphHash,
      )

      return provide(
        Effect.gen(function* () {
          yield* Client.start(original.Parent, 'x')
          const refused = yield* Effect.flip(Client.start(rebound.Parent, 'x'))

          expect(refused._tag).toBe('DefinitionConflict')
          expect(refused.message).toContain(
            'already saved with a different graph or different child revisions',
          )
          expect(inspect.runs()).toHaveLength(1)
          // The task revision only the refused start named was not saved.
          expect(
            yield* Client.getDefinition(refOf(rebound.Task)),
          ).toBeUndefined()
        }),
      )
    },
  )

  it.effect(
    'accepts a relabelled definition and keeps the labels of older runs',
    () => {
      const before = deploy('labels', 'v1', 'Before')
      const after = deploy('labels', 'v1', 'After')
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const older = yield* Client.start(before.Parent, 'x')
          const newer = yield* Client.start(after.Parent, 'y')

          expect(newer.graphHash).toBe(older.graphHash)
          expect((yield* Client.inspect(older.id))!.definition).toMatchObject({
            source: 'saved',
            presentation: captureGraphPresentation(before.Parent),
          })
          expect((yield* Client.inspect(newer.id))!.definition).toMatchObject({
            source: 'saved',
            presentation: captureGraphPresentation(after.Parent),
          })
        }),
      )
    },
  )

  it.effect(
    'keeps what is saved out of reach of whoever holds the declaration',
    () => {
      const v1 = deploy('immutable', 'v1', 'Title')
      const { provide } = deployment()
      const { manifest, presentation } = describeDefinition(v1.Parent)

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(v1.Parent, 'x')
          const carried = v1.Parent.program.definition!
          const own = `revision:${JSON.stringify(['workflow', v1.Parent.name, 'v1'])}`
          const { bindings } = carried.records.find(({ key }) => key === own)!
            .value as RevisionManifest
          expect(bindings).toStrictEqual(manifest!.bindings)

          // What a start saves is what the declaration carries, so it must
          // not change under the store.
          expect(() => {
            ;(bindings[0]!.target as { revision: string }).revision = 'mutated'
          }).toThrow(TypeError)
          expect(() => {
            ;(carried.presentation as { title: string }).title = 'mutated'
          }).toThrow(TypeError)

          expect(
            (yield* Client.getDefinition(refOf(v1.Parent)))!.revision,
          ).toStrictEqual(manifest)
          expect((yield* Client.inspect(run.id))!.definition).toMatchObject({
            presentation,
          })
        }),
      )
    },
  )

  it.effect('runs and saves a workflow whose case key is empty', () => {
    const Flow = workflow(
      { name: 'emptykey', pool, input: text, output: text },
      function* (w) {
        return yield* w.branch('route', {
          select: Effect.succeed('' as const),
          cases: (p) => ({
            '': p.activity({
              input: text,
              output: text,
              from: w.input,
              handler: (input) => Effect.succeed(`${input}!`),
            }),
          }),
        })
      },
    )
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Flow, 'x')
        yield* serve({ workflows: [Flow] })

        expect((yield* stored(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'x!',
        })
        expect((yield* Client.inspect(run.id))!.definition).toMatchObject({
          source: 'saved',
          structure: projectStructure(Flow),
        })
      }),
    )
  })

  it('refuses two definitions of one revision reachable from one workflow', () => {
    const one = bound('closure', 't1')
    const other = bound('closure', 't2')

    // Both parents are `closure.parent@p1`, with different bindings.
    expect(() =>
      workflow(
        {
          name: 'closure.root',
          revision: 'r1',
          pool,
          input: text,
          output: text,
        },
        function* (w) {
          yield* w.workflow('one', one.Parent, { input: w.input })
          yield* w.workflow('other', other.Parent, { input: w.input })
          return w.input
        },
      ),
    ).toThrow(
      'Two definitions of workflow [closure.parent@p1] with different graphs or child revisions are reachable from workflow [closure.root@r1]',
    )
  })
})

describe('definition drift on a worker', () => {
  it.effect(
    'sets aside a continuation whose registered graph differs, and advances nothing',
    () => {
      const v1 = deploy('workerdrift', 'v1')
      const drifted = reshape('workerdrift', 'v1')
      const { provide, inspect } = deployment({ maxDeliveries: 1 })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(v1.Parent, 'x')
          yield* serve(drifted)

          const untouched = yield* stored(run.id)
          expect(untouched.run).toMatchObject({ status: 'queued', version: 1 })
          expect(untouched.nodes).toHaveLength(0)
          expect(drifted.seen.ran).toBe(0)
          expect(inspect.queue()).toHaveLength(0)
          expect(inspect.dead()).toMatchObject([
            {
              command: { kind: 'continueRun', runId: run.id },
              error: {
                name: 'DefinitionConflict',
                message: `Registered workflow [workerdrift.parent@v1] does not have the graph run [${run.id}] was created with; a changed definition needs a new revision`,
              },
            },
          ])
        }),
      )
    },
  )

  it.effect(
    'ends the run with the conflict, once its continuation was set aside',
    () => {
      const v1 = deploy('reapdrift', 'v1')
      const drifted = reshape('reapdrift', 'v1')
      const { provide, inspect } = deployment({ maxDeliveries: 1 })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(v1.Parent, 'x')
          // Long enough for the coordinator to reap what it set aside.
          yield* serve(drifted, 31_000)

          const ended = yield* stored(run.id)
          expect(ended.run).toMatchObject({
            status: 'failed',
            revision: 'v1',
            error: {
              name: 'DefinitionConflict',
              message: `Registered workflow [reapdrift.parent@v1] does not have the graph run [${run.id}] was created with; a changed definition needs a new revision`,
            },
          })
          // Nothing of the drifted code ever ran for it.
          expect(ended.nodes).toHaveLength(0)
          expect(drifted.seen.ran).toBe(0)
          expect(inspect.queue()).toHaveLength(0)

          // The original code can take the run up again where it was.
          yield* Client.retry(run.id)
          expect(inspect.dead()).toHaveLength(0)
          yield* serve(v1)
          expect((yield* stored(run.id)).run).toMatchObject({
            status: 'completed',
            revision: 'v1',
          })
        }),
      )
    },
  )

  it.effect('never runs an activity handler of a drifted workflow', () => {
    const v1 = deploy('activitydrift', 'v1')
    const drifted = reshape('activitydrift', 'v1')
    const { provide, inspect } = deployment({ maxDeliveries: 1 })

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(v1.Parent, 'x')
        yield* coordinate(v1.workflows)
        expect(inspect.queue()).toMatchObject([
          { command: { kind: 'runAttempt', nodeName: 'first' } },
        ])

        // Its `first` is an activity too: only the definition tells them apart.
        yield* execute(drifted, 5_000)

        expect(drifted.seen.ran).toBe(0)
        const parked = yield* stored(run.id)
        expect(parked.attempts).toMatchObject([{ status: 'started' }])
        // Nothing past the drifted activity was ever created.
        expect(parked.nodes.map(({ name }) => name)).toStrictEqual(['first'])
        expect(inspect.dead()).toMatchObject([
          {
            command: { kind: 'runAttempt' },
            error: { name: 'DefinitionConflict' },
          },
        ])
      }),
    )
  })

  it.effect(
    'does not advance a run whose registered child bindings differ',
    () => {
      const original = bound('workerbind', 't1')
      const rebound = bound('workerbind', 't2')
      const { provide, inspect } = deployment({ maxDeliveries: 1 })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(original.Parent, 'x')
          yield* serve(rebound)

          expect(yield* status(run.id)).toBe('queued')
          // No child of either task revision was started.
          expect(inspect.runs()).toHaveLength(1)
          expect(inspect.dead()).toMatchObject([
            {
              error: {
                name: 'DefinitionConflict',
                message:
                  'Registered workflow [workerbind.parent@p1] binds different child revisions than its saved manifest; a changed definition needs a new revision',
              },
            },
          ])
        }),
      )
    },
  )

  it.effect(
    'writes nothing of a pass that would start a child edited under its revision',
    () => {
      const family = (steps: readonly string[]) => {
        const Child = workflow(
          {
            name: 'childdrift.child',
            revision: 'c1',
            pool,
            input: text,
            output: text,
          },
          function* (w) {
            for (const step of steps) {
              yield* w.activity(step, {
                input: text,
                output: text,
                from: w.input,
                handler: (input) => Effect.succeed(input),
              })
            }
            return w.input
          },
        )
        const Parent = workflow(
          {
            name: 'childdrift.parent',
            revision: 'p1',
            pool,
            input: text,
            output: text,
          },
          function* (w) {
            yield* w.workflow('sub', Child, { input: w.input })
            return w.input
          },
        )
        return { Parent, workflows: [Parent, Child], tasks: [] }
      }
      const original = family(['one'])
      // The parent still binds `child@c1`: its own manifest has not changed.
      const edited = family(['one', 'two'])
      const { provide, inspect } = deployment({ maxDeliveries: 1 })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(original.Parent, 'x')
          const saved = new Map(inspect.definitions())
          yield* serve(edited)

          const untouched = yield* stored(run.id)
          expect(untouched.run).toMatchObject({ status: 'queued', version: 1 })
          expect(untouched.nodes).toHaveLength(0)
          expect(inspect.runs()).toHaveLength(1)
          expect(inspect.definitions()).toStrictEqual(saved)
          expect(inspect.dead()).toMatchObject([
            {
              command: { kind: 'continueRun', runId: run.id },
              error: {
                name: 'DefinitionConflict',
                message:
                  'workflow [childdrift.child@c1] is already saved with a different graph or different child revisions; a changed definition needs a new revision',
              },
            },
          ])
        }),
      )
    },
  )

  it.effect('runs an unversioned run with whatever its name is now', () => {
    const legacy = deploy('loose')
    const reshaped = reshape('loose')
    const { provide, inspect } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(legacy.Parent, 'x')
        yield* serve(reshaped)

        expect((yield* stored(run.id)).run).toMatchObject({
          status: 'completed',
          output: ['x|reshaped'],
          // What the run was created with, not what ran it.
          graphHash: describeDefinition(legacy.Parent).graphHash,
        })
        expect(inspect.dead()).toHaveLength(0)
      }),
    )
  })

  it.effect(
    'settles a cancelled workflow run once its revision is served, drifted or not',
    () => {
      const v1 = deploy('cancel', 'v1')
      const v2 = deploy('cancel', 'v2')
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(v1.Parent, 'x')
          expect((yield* Client.cancel(run.id))!.status).toBe('cancelling')
          yield* serve(v2)
          expect(yield* status(run.id)).toBe('cancelling')

          // Cancellation walks stored state and needs no code of the run.
          yield* serve(reshape('cancel', 'v1'))
          expect(yield* status(run.id)).toBe('cancelled')
        }),
      )
    },
  )

  it.effect('cancels a task run of an unserved revision at once', () => {
    const v1 = deploy('canceltask', 'v1')
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(v1.Task, 'x')

        expect((yield* Client.cancel(run.id))!.status).toBe('cancelled')
      }),
    )
  })
})

describe('idempotency and uniqueness', () => {
  it.effect(
    'replays a key for the same revision and conflicts for another',
    () => {
      const v1 = deploy('idem', 'v1')
      const v2 = deploy('idem', 'v2')
      const { provide, inspect } = deployment()
      const idempotencyKey = ['idem', 'order-1']

      return provide(
        Effect.gen(function* () {
          const first = yield* Client.start(v1.Parent, 'x', { idempotencyKey })
          const replay = yield* Client.start(v1.Parent, 'x', { idempotencyKey })
          expect(replay.id).toBe(first.id)

          const conflict = yield* Effect.flip(
            Client.start(v2.Parent, 'x', { idempotencyKey }),
          )
          expect(conflict).toMatchObject({
            _tag: 'IdempotencyConflict',
            name: v2.Parent.name,
            runId: first.id,
          })
          expect(inspect.runs()).toHaveLength(1)
        }),
      )
    },
  )

  it.effect('replays an unversioned key whatever the graph has become', () => {
    const legacy = deploy('idemlegacy')
    const reshaped = reshape('idemlegacy')
    const { provide } = deployment()
    const idempotencyKey = ['idemlegacy', 'order-1']

    return provide(
      Effect.gen(function* () {
        const first = yield* Client.start(legacy.Parent, 'x', {
          idempotencyKey,
        })
        // Unversioned code changes under its name between deployments; the
        // key keeps naming the run it created.
        const replay = yield* Client.start(reshaped.Parent, 'x', {
          idempotencyKey,
        })

        expect(replay.id).toBe(first.id)
        expect(replay.graphHash).toBe(first.graphHash)
      }),
    )
  })

  it.effect('joins a unique key only as the same workflow and revision', () => {
    const v1 = deploy('join', 'v1')
    const v2 = deploy('join', 'v2')
    const legacy = deploy('join')
    const { provide, inspect } = deployment()
    const join = { key: ['join', 'tenant'], behavior: 'join' } as const

    return provide(
      Effect.gen(function* () {
        const holder = yield* Client.start(v1.Parent, 'x', { unique: join })
        expect((yield* Client.start(v1.Parent, 'y', { unique: join })).id).toBe(
          holder.id,
        )

        for (const declaration of [v2.Parent, legacy.Parent]) {
          const conflict = yield* Effect.flip(
            Client.start(declaration, 'x', { unique: join }),
          )
          expect(conflict).toMatchObject({
            _tag: 'RunConflict',
            runId: holder.id,
            status: 'queued',
            key: join.key,
            scope: 'active',
            holder: { kind: 'workflow', name: v1.Parent.name, revision: 'v1' },
          })
        }

        const rejected = yield* Effect.flip(
          Client.start(v2.Parent, 'x', { unique: { key: join.key } }),
        )
        expect(rejected).toMatchObject({
          _tag: 'RunConflict',
          runId: holder.id,
        })
        expect(rejected).not.toHaveProperty('holder')
        // The key stays global: no second live run exists under it.
        expect(inspect.runs()).toHaveLength(1)
      }),
    )
  })

  it.effect('joins two unversioned runs as before, whatever they are', () => {
    const legacy = deploy('joinlegacy')
    const Other = task({
      name: 'joinlegacy.other',
      pool,
      input: text,
      output: text,
      handler: (input) => Effect.succeed(input),
    })
    const { provide, inspect } = deployment()
    const join = { key: ['joinlegacy', 'tenant'], behavior: 'join' } as const

    return provide(
      Effect.gen(function* () {
        const holder = yield* Client.start(legacy.Parent, 'x', { unique: join })
        const joined = yield* Client.start(Other, 'x', { unique: join })

        expect(joined).toMatchObject({
          id: holder.id,
          name: legacy.Parent.name,
          input: 'x',
        })
        expect(inspect.runs()).toHaveLength(1)
      }),
    )
  })
})

describe('codecs', () => {
  /**
   * One generation of a workflow whose every durable value is an amount,
   * handled as a number and stored as text in `scale` units. Generations share
   * a graph and differ only in that encoding, and each reads the other's
   * storage without complaint: the wrong codec gives an amount off by the
   * ratio of the scales, never an error.
   */
  function amounts(revision: string, scale: number) {
    const amount = Schema.String.pipe(
      Schema.decodeTo(
        Schema.Number,
        SchemaTransformation.transform({
          decode: (held) => Number(held) / scale,
          encode: (value) => String(value * scale),
        }),
      ),
    )
    const io = { input: amount, output: amount }
    // What handlers were actually given, in whatever order they ran.
    const received: number[] = []
    const add = (increment: number) => (input: number) =>
      Effect.sync(() => {
        received.push(input)
        return input + increment
      })

    const Task = task({
      ...io,
      name: 'amounts.task',
      revision,
      pool,
      handler: add(1),
    })
    // Every node reads an earlier node's stored output, so each step crosses
    // the durable boundary in both directions.
    const Parent = workflow(
      {
        name: 'amounts.parent',
        revision,
        pool,
        input: amount,
        output: Schema.Array(amount),
      },
      function* (w) {
        const first = yield* w.activity('first', {
          ...io,
          from: w.input,
          handler: add(10),
        })
        const work = yield* w.task('work', Task, { input: first })
        const route = yield* w.branch('route', {
          select: Effect.succeed('inline' as const),
          cases: (p) => ({
            viaTask: p.task(Task, { input: work }),
            inline: p.activity({ ...io, from: work, handler: add(100) }),
          }),
        })
        const both = yield* w.parallel('both', {
          members: (p) => ({
            left: p.task(Task, { input: route }),
            inline: p.activity({ ...io, from: route, handler: add(1000) }),
          }),
        })
        const each = yield* w.mapTask('each', Task, {
          item: amount,
          items: Effect.map(both, ({ left, inline }) => [left, inline]),
          input: (item) => Effect.succeed(item),
        })

        return Effect.gen(function* () {
          const { left, inline } = yield* both
          return [
            yield* first,
            yield* work,
            yield* route,
            left,
            inline,
            ...(yield* each).items.map(({ output }) => output),
          ]
        })
      },
    )

    return { received, Parent, workflows: [Parent], tasks: [Task] }
  }

  it.effect(
    'reads and writes every durable value of a run with the codecs of its own revision',
    () => {
      const units = amounts('units', 1)
      const cents = amounts('cents', 100)
      const { provide } = deployment()

      // Same shape, so nothing but the revision tells the two apart.
      expect(describeDefinition(cents.Parent).graphHash).toBe(
        describeDefinition(units.Parent).graphHash,
      )

      const durable = (runId: string) =>
        Effect.map(stored(runId), ({ run, nodes }) => {
          expect(run.status).toBe('completed')
          const output = (name: string) =>
            nodes.find((node) => node.name === name)!.output
          const each = output('each') as {
            readonly items: readonly { item: unknown; output: unknown }[]
          }
          return {
            input: run.input,
            output: run.output,
            first: output('first'),
            work: output('work'),
            route: output('route'),
            both: output('both'),
            each: each.items.map(({ item, output }) => ({ item, output })),
          }
        })

      return provide(
        Effect.gen(function* () {
          const inUnits = yield* Client.start(units.Parent, 5)
          const inCents = yield* Client.start(cents.Parent, 5)
          expect(inCents.input).toBe(5)
          // One worker serves both and interleaves them: every pass takes its
          // codecs from the run it resumes, not from what it touched last.
          yield* serve(all(units, cents))

          // Handlers of both revisions saw the same amounts: 5, then what
          // each earlier node produced. A crossed codec would be off by 100.
          const handled = [5, 15, 16, 116, 116, 117, 1116]
          for (const { received } of [units, cents]) {
            expect(received.toSorted((a, b) => a - b)).toStrictEqual(handled)
          }

          expect(yield* durable(inUnits.id)).toEqual({
            input: '5',
            output: ['15', '16', '116', '117', '1116', '118', '1117'],
            first: '15',
            work: '16',
            route: '116',
            both: { left: '117', inline: '1116' },
            each: [
              { item: '117', output: '118' },
              { item: '1116', output: '1117' },
            ],
          })
          expect(yield* durable(inCents.id)).toEqual({
            input: '500',
            output: [
              '1500',
              '1600',
              '11600',
              '11700',
              '111600',
              '11800',
              '111700',
            ],
            first: '1500',
            work: '1600',
            route: '11600',
            both: { left: '11700', inline: '111600' },
            each: [
              { item: '11700', output: '11800' },
              { item: '111600', output: '111700' },
            ],
          })
        }),
      )
    },
  )
})

describe('inspection', () => {
  it.effect('returns the saved graph, labels and bindings of a run', () => {
    const v1 = deploy('inspect', 'v1', 'Saved')
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(v1.Parent, 'x')
        yield* serve(v1)

        const inspection = (yield* Client.inspect(run.id))!
        const { structure, graphHash, presentation, manifest } =
          describeDefinition(v1.Parent)
        expect(inspection.detail.run).toMatchObject({
          id: run.id,
          status: 'completed',
          revision: 'v1',
        })
        expect(inspection.definition).toStrictEqual({
          source: 'saved',
          graphHash,
          structure,
          presentation,
          revision: manifest,
        })

        // Summaries carry no payloads, and every run the parent started.
        expect(inspection.detail.run).not.toHaveProperty('input')
        expect(inspection.detail.run).not.toHaveProperty('output')
        expect(inspection.detail.run).not.toHaveProperty('presentation')
        expect(inspection.detail.nodes).toHaveLength(6)
        for (const node of inspection.detail.nodes) {
          expect(node).not.toHaveProperty('output')
        }
        expect(inspection.detail.childRuns).toHaveLength(7)

        // A child shows its own graph and labels, not its parent's.
        const child = inspection.detail.childRuns.find(
          ({ name }) => name === v1.Child.name,
        )!
        expect((yield* Client.inspect(child.id))!.definition).toMatchObject({
          source: 'saved',
          structure: projectStructure(v1.Child),
          presentation: captureGraphPresentation(v1.Child),
        })
        expect(yield* Client.inspect('missing-run')).toBeUndefined()
      }),
    )
  })

  it.effect('previews a branch alternative the run never took', () => {
    const v1 = deploy('preview', 'v1')
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        // Started, never worked: no child run of any kind exists.
        const run = yield* Client.start(v1.Parent, 'x')

        const { definition } = (yield* Client.inspect(run.id))!
        if (definition.source !== 'saved') {
          return yield* Effect.die('Expected a saved definition')
        }
        const binding = definition.revision!.bindings.find(
          ({ nodeName, caseKey }) =>
            nodeName === 'route' && caseKey === 'viaChild',
        )!

        expect(yield* Client.getDefinition(binding.target)).toStrictEqual({
          revision: describeDefinition(v1.Child).manifest,
          graph: {
            graphHash: describeDefinition(v1.Child).graphHash,
            structure: projectStructure(v1.Child),
          },
        })
        expect(
          yield* Client.getDefinition({ ...binding.target, revision: 'v9' }),
        ).toBeUndefined()
      }),
    )
  })

  it.effect(
    'reports a run that names no graph as observed only, whatever is deployed',
    () => {
      const legacy = deploy('observed', undefined, 'Today')
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          // Started by route alone: what a run created without a
          // description of its program looks like.
          const { run } = yield* start({ name: legacy.Parent.name, input: 'x' })
          yield* serve(legacy)

          const inspection = (yield* Client.inspect(run.id))!
          expect(inspection.definition).toStrictEqual({
            source: 'observed',
            reason: 'legacy',
          })
          expect(inspection.detail.run.status).toBe('completed')
          expect(inspection.detail.nodes).toHaveLength(6)
        }),
      )
    },
  )

  it.effect(
    'saves a graph for new unversioned runs without pinning them',
    () => {
      const legacy = deploy('unversioned', undefined, 'Then')
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(legacy.Parent, 'x')

          expect((yield* Client.inspect(run.id))!.definition).toStrictEqual({
            source: 'saved',
            graphHash: run.graphHash,
            structure: projectStructure(legacy.Parent),
            presentation: captureGraphPresentation(legacy.Parent),
          })
        }),
      )
    },
  )
})

describe('inspection of damaged definitions', () => {
  const { Parent, Task } = bound('damaged', 't1')
  const ref = refOf(Parent)
  const described = describeDefinition(Parent)
  const graph = `graph:${described.graphHash}`
  const manifest = `revision:${JSON.stringify(['workflow', Parent.name, 'p1'])}`

  /**
   * A started run read through a store whose definition records are changed
   * on the way out: nothing writes such records, it is what damage looks like.
   */
  const damaged = (
    change: (definitions: Map<string, unknown>) => void,
    read: (runId: string) => Effect.Effect<void, unknown, Store>,
  ) => {
    const { provide, store } = deployment()
    const tampered: typeof store.transact = (scope, plan) =>
      store.transact(scope, (snapshot: Snapshot) => {
        const definitions = new Map(snapshot.definitions)
        change(definitions)
        return plan({ ...snapshot, definitions })
      })

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Parent, 'x')
        expect(yield* Client.inspect(run.id)).toMatchObject({
          definition: { source: 'saved', revision: described.manifest },
        })
        yield* Effect.provideService(read(run.id), Store, {
          ...store,
          transact: tampered,
        })
      }),
    )
  }

  it.effect('reports a missing graph instead of the deployed definition', () =>
    damaged(
      (definitions) => definitions.set(graph, undefined),
      Effect.fnUntraced(function* (runId) {
        expect(yield* Client.inspect(runId)).toMatchObject({
          detail: { run: { id: runId } },
          definition: { source: 'observed', reason: 'missing-graph' },
        })
        expect(yield* Client.getDefinition(ref)).toBeUndefined()
      }),
    ),
  )

  it.effect('reports a graph that no longer hashes to its key', () =>
    damaged(
      (definitions) =>
        definitions.set(graph, { ...described.structure, name: 'other' }),
      Effect.fnUntraced(function* (runId) {
        expect((yield* Client.inspect(runId))!.definition).toStrictEqual({
          source: 'observed',
          reason: 'invalid-graph',
        })
        expect(yield* Effect.flip(Client.getDefinition(ref))).toMatchObject({
          _tag: 'DefinitionConflict',
          message: `Graph [${described.graphHash}] saved for workflow [damaged.parent@p1] does not match its hash`,
        })
      }),
    ),
  )

  it.effect('reports a record that is not a structure at all', () =>
    damaged(
      (definitions) => definitions.set(graph, { nodes: 'gone' }),
      Effect.fnUntraced(function* (runId) {
        expect((yield* Client.inspect(runId))!.definition).toStrictEqual({
          source: 'observed',
          reason: 'invalid-graph',
        })
      }),
    ),
  )

  it.effect('omits bindings that belong to another graph', () =>
    damaged(
      (definitions) =>
        definitions.set(manifest, {
          ...described.manifest,
          graphHash: 'f'.repeat(64),
        }),
      Effect.fnUntraced(function* (runId) {
        const { definition } = (yield* Client.inspect(runId))!
        expect(definition.source).toBe('saved')
        expect(definition).not.toHaveProperty('revision')
      }),
    ),
  )

  it.effect(
    'refuses a saved revision whose graph describes another definition',
    () => {
      const task = describeDefinition(Task)
      return damaged(
        (definitions) =>
          definitions.set(manifest, {
            ...described.manifest,
            graphHash: task.graphHash,
          }),
        Effect.fnUntraced(function* () {
          expect(yield* Effect.flip(Client.getDefinition(ref))).toMatchObject({
            _tag: 'DefinitionConflict',
            message: `Graph [${task.graphHash}] saved for workflow [damaged.parent@p1] describes another definition`,
          })
        }),
      )
    },
  )
})
