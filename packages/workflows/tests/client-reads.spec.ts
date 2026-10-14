import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import type {
  DecodedRun,
  Program,
  StartError,
  StorageError,
} from '../src/index.ts'
import {
  cancel,
  Client,
  RunConflict,
  RunNotFound,
  RunNotRoot,
  RunNotTerminal,
  start,
  Store,
  task,
  UnknownDefinition,
  workflow,
} from '../src/index.ts'
import {
  completed,
  elapse,
  failed,
  idle,
  load,
  pass,
  setup,
  unused,
  work,
} from './support.ts'
import { deployment, serve } from './typed-support.ts'

const Order = Schema.Struct({
  id: Schema.String,
  // Text where it is stored, a number wherever code sees it.
  cents: Schema.NumberFromString,
})
type Order = typeof Order.Type

/** One revision of a task and of a workflow that runs it. */
function declare(revision?: string) {
  const io = { pool: 'test', input: Order, output: Schema.String, revision }
  const Pay = task({
    ...io,
    name: 'pay',
    tags: (input) => ({ order: input.id }),
    handler: (input) => Effect.succeed(`${input.cents} by ${revision}`),
  })
  const Checkout = workflow(
    {
      ...io,
      name: 'checkout',
      tags: (input) => ({ order: input.id }),
      unique: (input) => ['checkout', input.id],
    },
    function* (w) {
      return yield* w.task('pay', Pay, { input: w.input })
    },
  )
  return { Pay, Checkout, all: { workflows: [Checkout], tasks: [Pay] } }
}

describe('restart', () => {
  it.effect(
    'starts a new run of the same declaration from the stored input',
    () => {
      const { Pay, Checkout, all } = declare()
      const { provide, inspect } = deployment()

      return provide(
        Effect.gen(function* () {
          const first = yield* Client.start(
            Checkout,
            { id: 'o-1', cents: 1200 },
            { tags: { order: 'o-1', source: 'api' } },
          )
          yield* serve(all)
          expect((yield* Client.get(first.id))!.run.status).toBe('completed')

          const again = yield* Client.restart(first.id, {
            definitions: [Pay, Checkout],
          })
          expectTypeOf(again).toEqualTypeOf<DecodedRun<Order, string>>()
          expect(again.id).not.toBe(first.id)
          // Read back with the declaration's codec, not copied as JSON.
          expect(again).toMatchObject({
            kind: 'workflow',
            name: 'checkout',
            status: 'queued',
            input: { id: 'o-1', cents: 1200 },
            rootRunId: again.id,
            // The stored tags, not what the builder would say today.
            tags: { order: 'o-1', source: 'api' },
            unique: { key: ['checkout', 'o-1'], scope: 'active' },
          })
          expect((yield* Client.get(again.id))!.run.input).toStrictEqual({
            id: 'o-1',
            cents: '1200',
          })
          // The stored constraint holds for the new run as it did before.
          expect(inspect.keys().get('unique:active:["checkout","o-1"]')).toBe(
            again.id,
          )
          expect(
            yield* Effect.flip(
              Client.restart(first.id, { definitions: [Checkout] }),
            ),
          ).toStrictEqual(
            new RunConflict({
              runId: again.id,
              status: 'queued',
              key: ['checkout', 'o-1'],
              scope: 'active',
            }),
          )

          yield* serve(all)
          expect((yield* Client.get(again.id))!.run).toMatchObject({
            status: 'completed',
            output: '1200 by undefined',
          })
        }),
      )
    },
  )

  it.effect(
    'takes the options of a start, each replacing what is stored',
    () => {
      const { Checkout, all } = declare()
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const first = yield* Client.start(Checkout, { id: 'o-1', cents: 1 })
          yield* serve(all)

          const again = yield* Client.restart(first.id, {
            definitions: [Checkout],
            tags: { replay: 'yes' },
            idempotencyKey: ['replay', 1],
            unique: { key: ['replay'], scope: 'all' },
            startAt: 60_000,
          })
          expect(again).toMatchObject({
            tags: { replay: 'yes' },
            idempotencyKey: ['replay', 1],
            unique: { key: ['replay'], scope: 'all', behavior: 'reject' },
          })
          // Delayed like any start: the run exists, and nothing takes it yet.
          yield* serve(all, 5_000)
          expect((yield* Client.get(again.id))!.run.status).toBe('queued')
          // The same request again is the same run.
          const replayed = yield* Client.restart(first.id, {
            definitions: [Checkout],
            idempotencyKey: ['replay', 1],
          })
          expect(replayed.id).toBe(again.id)
        }),
      )
    },
  )

  it.effect('uses the run’s own revision, and never another', () => {
    const v1 = declare('v1')
    const v2 = declare('v2')
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const first = yield* Client.start(v1.Pay, { id: 'o-1', cents: 5 })
        yield* cancel(first.id)

        const again = yield* Client.restart(first.id, {
          definitions: [v2.Pay, v1.Pay, v1.Checkout],
        })
        expect(again).toMatchObject({ kind: 'task', revision: 'v1' })
        yield* serve({ tasks: [v1.Pay, v2.Pay] })
        expect((yield* Client.get(again.id))!.run.output).toBe('5 by v1')

        // Not the workflow of that name, nor the task of another revision.
        const unknown = yield* Effect.flip(
          Client.restart(first.id, {
            definitions: [v2.Pay, v1.Checkout, declare().Pay],
          }),
        )
        expect(unknown).toStrictEqual(
          new UnknownDefinition({
            runId: first.id,
            kind: 'task',
            name: 'pay',
            revision: 'v1',
          }),
        )
        expect(unknown.message).toBe(
          `Cannot restart run [${first.id}]: no task definition [pay@v1] was given`,
        )
      }),
    )
  })

  it.effect('is refused for a run that has not ended, or is not a root', () => {
    const { Pay, Checkout, all } = declare()
    const { provide, inspect } = deployment()
    const definitions = [Pay, Checkout] as const

    return provide(
      Effect.gen(function* () {
        const restarting = (runId: string) =>
          Effect.flip(Client.restart(runId, { definitions }))
        expectTypeOf(restarting).returns.toEqualTypeOf<
          Effect.Effect<
            | StartError
            | RunNotFound
            | RunNotRoot
            | RunNotTerminal
            | UnknownDefinition
            | StorageError,
            DecodedRun<Order, string>,
            Store
          >
        >()

        expect(yield* restarting('run-404')).toStrictEqual(
          new RunNotFound({ runId: 'run-404' }),
        )
        const run = yield* Client.start(Checkout, { id: 'o-1', cents: 1 })
        expect(yield* restarting(run.id)).toStrictEqual(
          new RunNotTerminal({ runId: run.id, status: 'queued' }),
        )

        yield* serve(all)
        const [child] = (yield* Client.get(run.id))!.children
        expect(yield* restarting(child!.childRunId!)).toStrictEqual(
          new RunNotRoot({ runId: child!.childRunId! }),
        )
        expect(inspect.runs()).toHaveLength(2)
      }),
    )
  })
})

/** A parent of a task and of a child workflow, to list and to look at. */
const programs: readonly Program[] = [
  {
    kind: 'workflow',
    name: 'parent',
    steps: [
      {
        kind: 'activity',
        name: 'own',
        execute: unused,
        input: (_outputs, input) => ({ from: input }),
      },
      {
        kind: 'parallel',
        name: 'fan',
        members: {
          job: { kind: 'task', task: { name: 'job' }, input: () => 'j' },
          child: {
            kind: 'workflow',
            workflow: { name: 'child', revision: 'v1' },
            input: () => 'c',
          },
        },
      },
    ],
    result: ({ fan }) => fan,
  },
  {
    kind: 'workflow',
    name: 'child',
    revision: 'v1',
    steps: [
      {
        kind: 'activity',
        name: 'step',
        execute: unused,
        input: (_outputs, input) => input,
      },
    ],
    result: ({ step }) => step,
  },
  { kind: 'task', name: 'job', execute: unused },
]

/** A parent run past its first step, with both of its child runs started. */
const family = Effect.fnUntraced(function* (
  served: ReturnType<typeof setup>['served'],
) {
  const { run } = yield* start({
    name: 'parent',
    input: { tenant: 'acme', lines: [{ sku: 'a' }, { sku: 'b' }] },
    tags: { tenant: 'acme', tier: 'gold' },
  })
  yield* pass(served)
  yield* work(served, completed('own done'))
  yield* pass(served)
  const { children } = yield* load(run.id)
  const child = (key: string) =>
    children.find(({ childKey }) => childKey === key)!.childRunId!
  return {
    root: run.id,
    job: child('member:job'),
    child: child('member:child'),
  }
})

describe('lists', () => {
  it.effect('select runs by what they are and by what they hold', () => {
    const { served, provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const ids = yield* family(served)
        yield* TestClock.adjust(1_000)
        const other = yield* start({
          kind: 'task',
          name: 'job',
          input: { tenant: 'globex', lines: [] },
          tags: { tenant: 'globex' },
        })
        yield* cancel(other.run.id)

        const select = (filter: Client.ListFilter) =>
          Effect.map(Client.list(filter), ({ runs }) =>
            runs.map(({ id }) => id),
          )
        // Newest first, later created first among those of one moment.
        const all = [other.run.id, ids.child, ids.job, ids.root]
        expect(yield* select({})).toStrictEqual(all)

        expect(yield* select({ kind: 'task' })).toStrictEqual([
          other.run.id,
          ids.job,
        ])
        expect(yield* select({ name: 'child' })).toStrictEqual([ids.child])
        expect(yield* select({ revision: 'v1' })).toStrictEqual([ids.child])
        // `null` is the unversioned lane, not "any revision".
        expect(yield* select({ revision: null })).toStrictEqual([
          other.run.id,
          ids.job,
          ids.root,
        ])
        expect(yield* select({ status: 'cancelled' })).toStrictEqual([
          other.run.id,
        ])
        expect(yield* select({ status: ['queued', 'waiting'] })).toStrictEqual([
          ids.child,
          ids.job,
          ids.root,
        ])
        expect(yield* select({ status: [] })).toStrictEqual([])
        // Strictly before: the run created at that moment is not included.
        expect(yield* select({ createdBefore: 1_000 })).toStrictEqual([
          ids.child,
          ids.job,
          ids.root,
        ])
        expect(yield* select({ createdBefore: 0 })).toStrictEqual([])
        expect(yield* select({ activeBefore: 1 })).toStrictEqual([
          ids.child,
          ids.job,
          ids.root,
        ])
        expect(yield* select({ parentRunId: null })).toStrictEqual([
          other.run.id,
          ids.root,
        ])
        expect(yield* select({ parentRunId: ids.root })).toStrictEqual([
          ids.child,
          ids.job,
        ])
        expect(yield* select({ rootRunId: ids.root })).toStrictEqual([
          ids.child,
          ids.job,
          ids.root,
        ])
        expect(yield* select({ tags: { tenant: 'acme' } })).toStrictEqual([
          ids.root,
        ])
        expect(
          yield* select({ tags: { tenant: 'acme', tier: 'silver' } }),
        ).toStrictEqual([])
        // Containment: a subset of the fields, a subset of the items.
        expect(
          yield* select({ input: { lines: [{ sku: 'b' }] } }),
        ).toStrictEqual([ids.root])
        expect(yield* select({ input: { lines: [] } })).toStrictEqual([
          other.run.id,
          ids.root,
        ])
        expect(
          yield* select({ input: { lines: [{ sku: 'c' }] } }),
        ).toStrictEqual([])
        expect(yield* select({ input: 'j' })).toStrictEqual([ids.job])
        expect(
          yield* select({
            kind: 'workflow',
            revision: null,
            status: 'waiting',
          }),
        ).toStrictEqual([ids.root])
      }),
    )
  })

  it.effect(
    'give runs as stored, or without payloads and with their progress',
    () => {
      const { served, provide } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const ids = yield* family(served)
          const filter = { rootRunId: ids.root }

          const { runs } = yield* Client.list(filter)
          expect(runs).toStrictEqual([
            (yield* load(ids.child)).run,
            (yield* load(ids.job)).run,
            (yield* load(ids.root)).run,
          ])

          const summaries = yield* Client.listSummaries(filter)
          expect(summaries).toStrictEqual({
            runs: [
              {
                ...withoutPayloads(runs[0]!),
                nodesTotal: 0,
                nodesCompleted: 0,
                origin: { nodeName: 'fan', childKey: 'member:child' },
              },
              {
                ...withoutPayloads(runs[1]!),
                nodesTotal: 1,
                nodesCompleted: 0,
                origin: { nodeName: 'fan', childKey: 'member:job' },
              },
              {
                ...withoutPayloads(runs[2]!),
                nodesTotal: 2,
                nodesCompleted: 1,
              },
            ],
          })
          expect(summaries.runs[2]).not.toHaveProperty('input')
        }),
      )
    },
  )

  it.effect('are read a page at a time, each run once', () => {
    const { provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const started = yield* Effect.forEach(
          Array.from({ length: 205 }, (_, input) => input),
          (input) => start({ kind: 'task', name: 'job', input }),
        )
        const newest = started.map(({ run }) => run.id).reverse()

        for (const read of [Client.list, Client.listSummaries]) {
          // A hundred when no limit is given.
          const first = yield* read()
          expect(first.runs.map(({ id }) => id)).toStrictEqual(
            newest.slice(0, 100),
          )
          const second = yield* read({ cursor: first.nextCursor!, limit: 104 })
          expect(second.runs.map(({ id }) => id)).toStrictEqual(
            newest.slice(100, 204),
          )
          const last = yield* read({ cursor: second.nextCursor! })
          expect(last.runs.map(({ id }) => id)).toStrictEqual([newest[204]])
          expect(last.nextCursor).toBeUndefined()
          // A page that ends where the list does names no next one.
          expect((yield* read({ limit: 205 })).nextCursor).toBeUndefined()
          expect(yield* read({ limit: 0 })).toStrictEqual({ runs: [] })
        }

        // A filter pages over what it selects, not over everything.
        const even = yield* Client.list({ input: 2, limit: 1 })
        expect(even.runs.map(({ input }) => input)).toStrictEqual([2])
        expect(even.nextCursor).toBeUndefined()
      }),
    )
  })
})

const withoutPayloads = <A extends object>(record: A) => {
  const {
    input: _input,
    output: _output,
    item: _item,
    presentation: _presentation,
    ...rest
  } = record as A & Record<string, unknown>
  return rest
}

describe('reads of one run', () => {
  it.effect('answer nothing for what does not exist', () => {
    const { served, provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const ids = yield* family(served)
        expect(yield* Client.getDetail('run-404')).toBeUndefined()
        expect(yield* Client.getNode('run-404', 'own')).toBeUndefined()
        expect(yield* Client.getNode(ids.root, 'nope')).toBeUndefined()
        expect(yield* Client.getFamily('run-404')).toStrictEqual([])
      }),
    )
  })

  it.effect('give its detail without payloads, and a node with them', () => {
    const { served, provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const ids = yield* family(served)
        const records = (yield* Client.get(ids.root))!

        expect(yield* Client.getDetail(ids.root)).toStrictEqual({
          run: withoutPayloads(records.run),
          nodes: records.nodes.map(withoutPayloads),
          children: records.children.map(withoutPayloads),
          attempts: records.attempts.map(withoutPayloads),
          childRuns: [
            withoutPayloads((yield* load(ids.child)).run),
            withoutPayloads((yield* load(ids.job)).run),
          ],
        })
        // The detail is the one `inspect` gives beside the definition.
        expect((yield* Client.inspect(ids.root))!.detail).toStrictEqual(
          yield* Client.getDetail(ids.root),
        )

        const own = yield* Client.getNode(ids.root, 'own')
        expect(own).toStrictEqual({
          node: records.nodes.find(({ name }) => name === 'own'),
          children: records.children.filter(
            ({ nodeName }) => nodeName === 'own',
          ),
          attempts: records.attempts,
        })
        expect(own).toMatchObject({
          node: { output: 'own done' },
          attempts: [{ input: { from: expect.anything() } }],
        })
        expect(yield* Client.getNode(ids.root, 'fan')).toMatchObject({
          node: { kind: 'parallel', status: 'waiting' },
          // Members by key: `member:child` before `member:job`.
          children: [{ childRunId: ids.child }, { childRunId: ids.job }],
          attempts: [],
        })
      }),
    )
  })

  it.effect(
    'give its family from any member, each run once, oldest first',
    () => {
      const { served, provide } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const ids = yield* family(served)
          // Another family, and a child's own child, which a pass starts.
          yield* start({ name: 'parent', input: null })
          yield* pass(served)

          const expected = [
            { run: expect.objectContaining({ id: ids.root, nodesTotal: 2 }) },
            {
              run: expect.objectContaining({ id: ids.job, kind: 'task' }),
              origin: { nodeName: 'fan', childKey: 'member:job' },
            },
            {
              run: expect.objectContaining({ id: ids.child, nodesTotal: 1 }),
              origin: { nodeName: 'fan', childKey: 'member:child' },
            },
          ]
          for (const member of [ids.root, ids.job, ids.child]) {
            const listed = yield* Client.getFamily(member)
            expect(listed).toStrictEqual(expected)
            expect(listed[0]!.run).not.toHaveProperty('input')
            expect(listed[0]!.run).not.toHaveProperty('origin')
          }
        }),
      )
    },
  )

  it.effect('read a family larger than one page of it', () => {
    const wide: Program = {
      kind: 'workflow',
      name: 'wide',
      steps: [
        {
          kind: 'map',
          name: 'each',
          items: () => Array.from({ length: 250 }, (_, index) => index),
          input: (_outputs, _input, item) => item,
          target: { kind: 'task', task: { name: 'job' } },
        },
      ],
      result: ({ each }) => each,
    }
    const { served, provide } = setup([wide, ...programs])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'wide', input: null })
        yield* pass(served)

        const listed = yield* Client.getFamily(run.id)
        expect(listed).toHaveLength(251)
        expect(listed.map(({ origin }) => origin?.childKey)).toStrictEqual([
          undefined,
          ...Array.from({ length: 250 }, (_, index) => `item:${index}`),
        ])
      }),
    )
  })
})

describe('watch', () => {
  /** Collects what a watch gives, as it gives it. */
  const watching = Effect.fnUntraced(function* (
    runId: string,
    options?: Client.WatchOptions,
  ) {
    const events: Client.WatchEvent[] = []
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(Client.watch(runId, options), (event) =>
        Effect.sync(() => void events.push(event)),
      ),
    )
    yield* idle
    return { events, done: () => fiber.pollUnsafe() !== undefined }
  })

  const hint = (rootRunId: string) =>
    Effect.flatMap(Store, (store) =>
      store.transact({}, () => ({
        _tag: 'Commit',
        mutation: { notify: [`family:${rootRunId}`] },
        result: undefined,
      })),
    ).pipe(Effect.andThen(idle))

  it.effect('gives every status of a run, and ends with the last', () => {
    const { served, provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({
          name: 'child',
          revision: 'v1',
          input: 1,
        })
        const { events, done } = yield* watching(run.id)
        // The status it has, without waiting for a change.
        expect(events).toStrictEqual([{ kind: 'run', status: 'queued' }])

        yield* pass(served)
        yield* idle
        yield* work(served, failed('broke'))
        yield* idle
        expect(done()).toBe(false)
        yield* pass(served)
        yield* idle

        // Found at once, on the hints of the commits: the clock never moved.
        expect(events).toStrictEqual([
          { kind: 'run', status: 'queued' },
          { kind: 'run', status: 'running' },
          { kind: 'run', status: 'failed', error: { message: 'broke' } },
        ])
        expect(done()).toBe(true)
      }),
    )
  })

  it.effect(
    'gives the one status of a run that has ended, and nothing for none',
    () => {
      const { provide } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
          yield* cancel(run.id)

          expect(yield* Stream.runCollect(Client.watch(run.id))).toStrictEqual([
            { kind: 'run', status: 'cancelled' },
          ])
          expect(
            yield* Stream.runCollect(Client.watch('run-404')),
          ).toStrictEqual([])
          expect(() => Client.watch(run.id, { pollIntervalMs: 0 })).toThrow(
            'Watch pollIntervalMs must be positive',
          )
        }),
      )
    },
  )

  it.effect.each([
    ['every second', undefined, 1_000] as const,
    ['as often as it is told to', 250, 250] as const,
  ])(
    'finds a status by reading %s when no hint comes',
    ([, pollIntervalMs, interval]) => {
      const { provide, store } = setup(programs)
      const silent = Store.of({
        ...store,
        listen: () => Effect.succeed(Effect.never),
      })

      return Effect.provideService(
        Effect.gen(function* () {
          const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
          const { events, done } = yield* watching(
            run.id,
            pollIntervalMs === undefined ? {} : { pollIntervalMs },
          )

          yield* cancel(run.id)
          yield* elapse(interval - 50, 50)
          expect(events).toHaveLength(1)
          yield* elapse(50, 50)
          expect(events).toStrictEqual([
            { kind: 'run', status: 'queued' },
            { kind: 'run', status: 'cancelled' },
          ])
          expect(done()).toBe(true)
        }),
        Store,
        silent,
      ).pipe(provide)
    },
  )

  it.effect('says that something of the family changed, when asked to', () => {
    const { served, provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const ids = yield* family(served)
        const coarse = yield* watching(ids.root, { wake: true })
        const plain = yield* watching(ids.root)
        const other = yield* start({ kind: 'task', name: 'job', input: 1 })

        // The child's first pass: a change of the family, not of the root.
        yield* pass(served)
        yield* idle
        // A run of another family says nothing to this one.
        yield* cancel(other.run.id)
        yield* idle

        expect(coarse.events).toStrictEqual([
          { kind: 'run', status: 'waiting' },
          { kind: 'change' },
        ])
        expect(plain.events).toStrictEqual([{ kind: 'run', status: 'waiting' }])

        // A status is a `run` event, never a `change` as well.
        yield* cancel(ids.root)
        yield* idle
        expect(coarse.events.at(-1)).toStrictEqual({
          kind: 'run',
          status: 'cancelling',
        })
        expect(coarse.events).toHaveLength(3)
      }),
    )
  })

  it.effect(
    'collects the hints of a busy time into one change at each end of it',
    () => {
      const { served, provide } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const ids = yield* family(served)
          const { events, done } = yield* watching(ids.root, {
            wake: true,
            debounceMs: 1_000,
          })
          const changes = () =>
            events.filter(({ kind }) => kind === 'change').length

          // After a quiet time the first hint passes at once.
          yield* TestClock.adjust(5_000)
          yield* hint(ids.root)
          expect(changes()).toBe(1)

          // The others inside the window wait for it to close, as one.
          for (let burst = 0; burst < 5; burst++) {
            yield* elapse(100, 100)
            yield* hint(ids.root)
          }
          expect(changes()).toBe(1)
          yield* elapse(400, 100)
          expect(changes()).toBe(1)
          yield* elapse(100, 100)
          expect(changes()).toBe(2)

          // Nothing more came: the window closes without another event.
          yield* elapse(2_000, 100)
          expect(changes()).toBe(2)

          // A status inside a window is not held back by it.
          yield* hint(ids.root)
          expect(changes()).toBe(3)
          yield* elapse(100, 100)
          yield* cancel(ids.root)
          yield* idle
          expect(events.at(-1)).toStrictEqual({
            kind: 'run',
            status: 'cancelling',
          })
          yield* pass(served)
          yield* idle
          expect(events.at(-1)).toStrictEqual({
            kind: 'run',
            status: 'cancelled',
          })
          expect(done()).toBe(true)
          expect(changes()).toBe(3)
        }),
      )
    },
  )

  it.effect('reads the run as often inside a window as outside it', () => {
    const { provide, store } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
        const { events, done } = yield* watching(run.id, {
          wake: true,
          debounceMs: 60_000,
        })
        // The first hint passes; the second opens a window of a minute.
        yield* hint(run.id)
        yield* hint(run.id)
        expect(events.at(-1)).toStrictEqual({ kind: 'change' })

        // The run ends, and the hint that would say so is lost.
        yield* store.transact({ heads: [run.id] }, () => ({
          _tag: 'Commit',
          mutation: { runs: [{ ...run, status: 'cancelled', version: 2 }] },
          result: undefined,
        }))
        yield* elapse(1_000, 100)
        expect(events.at(-1)).toStrictEqual({
          kind: 'run',
          status: 'cancelled',
        })
        expect(done()).toBe(true)
      }),
    )
  })

  it.effect(
    'ends when the run fails, and is opened again after a retry',
    () => {
      const { served, provide } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({
            name: 'child',
            revision: 'v1',
            input: 1,
          })
          const first = yield* watching(run.id)
          yield* pass(served)
          yield* work(served, failed('broke'))
          yield* pass(served)
          yield* idle
          expect(first.done()).toBe(true)

          yield* Client.retry(run.id)
          const second = yield* watching(run.id)
          yield* pass(served)
          yield* idle
          yield* work(served, completed('fixed'))
          yield* pass(served)
          yield* idle

          expect(first.events.at(-1)).toMatchObject({ status: 'failed' })
          expect(second.events).toStrictEqual([
            { kind: 'run', status: 'queued' },
            { kind: 'run', status: 'running' },
            { kind: 'run', status: 'completed' },
          ])
        }),
      )
    },
  )
})
