import { describe, expect, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  AnyTask,
  CleanupTimeout,
  ServedWorkflow,
  StorageError,
  Store,
} from '../../src/index.ts'
import {
  Client,
  describeDefinition,
  durable,
  projectStructure,
  task,
  Worker,
  workflow,
} from '../../src/index.ts'
import { Draft, Review } from '../fixtures/review.ts'
import { idle } from '../support.ts'
import { coordinate, deployment, serve } from '../typed-support.ts'

const records = (runId: string) =>
  Effect.map(Client.get(runId), (found) => found!)

/** Node names in the order the run admitted them. */
const admitted = (runId: string) =>
  Effect.map(records(runId), ({ nodes }) =>
    nodes
      .toSorted(
        (a, b) => (a.operation?.ordinal ?? 0) - (b.operation?.ordinal ?? 0),
      )
      .map(({ name }) => name),
  )

/** What the workers serve for these declarations, each once. */
const served = (
  ...declared: readonly {
    readonly workflows: readonly ServedWorkflow[]
    readonly tasks: readonly AnyTask[]
  }[]
) => ({
  workflows: [...new Set(declared.flatMap(({ workflows }) => workflows))],
  tasks: [...new Set(declared.flatMap(({ tasks }) => tasks))],
})

describe('durable workflows', () => {
  it.effect(
    'runs steps decided by the run and branches on their outputs',
    () => {
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Review, {
            steps: [
              { id: 'a', hard: false },
              { id: 'b', hard: true },
              { id: 'c', hard: false },
            ],
          })
          yield* serve(served(Review))

          const { run: done } = yield* records(run.id)
          expect(done.status).toBe('completed')
          expect(done.output).toEqual([
            'draft a',
            'draft b',
            'fixed b',
            'draft c',
          ])
          expect(yield* admitted(run.id)).toEqual([
            'draft:a',
            'draft:b',
            'fix:b',
            'draft:c',
          ])
        }),
      )
    },
  )

  it.effect('opens the branches of a concurrent join in one pass', () => {
    const Both = durable(
      {
        name: 'durable.both',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Array(Schema.String),
        tasks: [Draft],
      },
      (_, d) =>
        Effect.all(
          [
            d.task('left', Draft, { id: 'l', hard: false }),
            d.task('right', Draft, { id: 'r', hard: false }),
          ],
          { concurrency: 'unbounded' },
        ).pipe(Effect.map((drafts) => drafts.map(({ text }) => text))),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Both, undefined)
        // One pass, nothing executed: both nodes are open and waiting.
        yield* coordinate(Both.workflows)
        // Given by name, as every read gives nodes.
        const { nodes } = yield* records(run.id)
        expect(nodes.map(({ name, status }) => [name, status])).toEqual([
          ['left', 'waiting'],
          ['right', 'waiting'],
        ])

        yield* serve(served(Both))
        const { run: done } = yield* records(run.id)
        expect(done.output).toEqual(['draft l', 'draft r'])
      }),
    )
  })

  it.effect(
    'sleeps durably, from when the run first comes to the sleep',
    () => {
      const Wait = durable(
        {
          name: 'durable.wait',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Struct({
            before: Schema.Number,
            after: Schema.Number,
          }),
        },
        (_, d) =>
          Effect.gen(function* () {
            const before = yield* d.now('before')
            yield* d.sleep('pause', '1h')
            const after = yield* d.now('after')
            return { before, after }
          }),
      )
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Wait, undefined)
          yield* serve(served(Wait), 30 * 60_000)
          expect((yield* records(run.id)).run.status).toBe('waiting')

          yield* serve(served(Wait), 31 * 60_000)
          const { run: done } = yield* records(run.id)
          expect(done.status).toBe('completed')
          const { before, after } = done.output as {
            before: number
            after: number
          }
          expect(after - before).toBeGreaterThanOrEqual(60 * 60_000)
        }),
      )
    },
  )

  it.effect('gives a failed operation to the body, which may go on', () => {
    const Flaky = task({
      name: 'durable.flaky',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.String,
      handler: () => Effect.fail(new Error('provider down')),
    })
    const Recover = durable(
      {
        name: 'durable.recover',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Flaky],
      },
      (_, d) =>
        d
          .task('call', Flaky, undefined, { onFailure: 'fail' })
          .pipe(
            Effect.catchTag('OperationFailed', ({ operation, error }) =>
              Effect.succeed(`${operation}: ${error.message}`),
            ),
          ),
    )
    const Unhandled = durable(
      {
        name: 'durable.unhandled',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Flaky],
        onFailure: 'fail',
      },
      (_, d) => d.task('call', Flaky, undefined),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const recovered = yield* Client.start(Recover, undefined)
        const failing = yield* Client.start(Unhandled, undefined)
        yield* serve(served(Recover, Unhandled))

        expect((yield* records(recovered.id)).run.output).toBe(
          'call: provider down',
        )
        const { run } = yield* records(failing.id)
        expect(run.status).toBe('failed')
        expect(run.error?.message).toContain('Durable operation [call] failed')
        // What the body decided from the failure stands: no retry in place.
        const refused = yield* Effect.flip(Client.retry(failing.id))
        expect(refused._tag).toBe('RunNotRetryable')
      }),
    )
  })

  it.effect('blocks a run whose body asks for one name twice', () => {
    const Twice = durable(
      {
        name: 'durable.twice',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        tasks: [Draft],
      },
      (_, d) =>
        Effect.gen(function* () {
          for (const id of ['a', 'b']) {
            yield* d.task('draft', Draft, { id, hard: false })
          }
        }),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Twice, undefined)
        yield* serve(served(Twice))
        const { run: done } = yield* records(run.id)
        expect(done.status).toBe('blocked')
        expect(done.error?.name).toBe('ReplayMismatch')
      }),
    )
  })

  it.effect(
    'blocks a run whose code asks for an operation it was not opened with',
    () => {
      const options = {
        name: 'durable.changed',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Draft],
      } as const
      const Before = durable(options, (_, d) =>
        Effect.map(
          d.task('draft', Draft, { id: 'old', hard: false }),
          ({ text }) => text,
        ),
      )
      // The same revision deployed again with a body that asks otherwise.
      const After = durable(options, (_, d) =>
        Effect.map(
          d.task('draft', Draft, { id: 'new', hard: false }),
          ({ text }) => text,
        ),
      )
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Before, undefined)
          yield* coordinate(Before.workflows)
          yield* serve(served(After))
          const { run: done } = yield* records(run.id)
          expect(done.status).toBe('blocked')
          expect(done.error?.name).toBe('ReplayMismatch')
          expect(done.error?.message).toContain('another input')
        }),
      )
    },
  )

  it.effect('fails a body that waits on anything but its operations', () => {
    const Waiting = durable(
      {
        name: 'durable.waiting',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
      },
      () => Effect.promise(() => new Promise<void>(() => {})),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Waiting, undefined)
        yield* serve(served(Waiting))
        const { run: done } = yield* records(run.id)
        expect(done.status).toBe('failed')
        expect(done.error?.message).toContain('cannot wait')
      }),
    )
  })

  it.effect('stops a branch the body let go of before the run ends', () => {
    const Slow = task({
      name: 'durable.slow',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.never,
    })
    const Broken = task({
      name: 'durable.broken',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.fail(new Error('broken')),
    })
    const Race = durable(
      {
        name: 'durable.race',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        tasks: [Slow, Broken],
        onFailure: 'fail',
      },
      (_, d) =>
        Effect.asVoid(
          Effect.all(
            [
              d.task('slow', Slow, undefined),
              d.task('broken', Broken, undefined),
            ],
            { concurrency: 'unbounded' },
          ),
        ),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Race, undefined)
        yield* serve(served(Race), 60_000)
        const found = yield* records(run.id)
        expect(found.run.status).toBe('failed')
        const slow = found.children.find(({ nodeName }) => nodeName === 'slow')!
        const child = yield* Client.get(slow.childRunId!)
        expect(child?.run.status).toBe('cancelled')
      }),
    )
  })

  it.effect('is cancelled while it sleeps', () => {
    const Sleeper = durable(
      {
        name: 'durable.sleeper',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
      },
      (_, d) => d.sleep('long', '7d'),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Sleeper, undefined)
        yield* coordinate(Sleeper.workflows)
        yield* Client.cancel(run.id)
        yield* coordinate(Sleeper.workflows, 2_000)
        yield* idle
        const { run: done, nodes } = yield* records(run.id)
        expect(done.status).toBe('cancelled')
        expect(nodes[0]?.status).toBe('cancelled')
      }),
    )
  })

  it('refuses what a durable workflow cannot pin', () => {
    const Loose = task({
      name: 'durable.loose',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.void,
    })
    expect(() =>
      durable(
        {
          name: 'durable.loose-user',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Void,
          tasks: [Loose],
        },
        (_, d) => d.task('loose', Loose, undefined),
      ),
    ).toThrow(/unversioned task/)
  })

  it('types what a body may start and require', () => {
    const Other = task({
      name: 'durable.other',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.void,
    })
    class Mailer extends Context.Service<
      Mailer,
      { readonly send: Effect.Effect<void> }
    >()('durable/Mailer') {}
    const options = {
      name: 'durable.typed',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      tasks: [Draft],
    } as const

    expect(() =>
      durable(options, (_, d) =>
        // @ts-expect-error a task the declaration does not say it uses
        d.task('other', Other, undefined),
      ),
    ).not.toThrow()
    expect(() =>
      durable(
        options,
        // @ts-expect-error a body requires nothing but `Durable`
        () => Effect.flatMap(Mailer, ({ send }) => send),
      ),
    ).not.toThrow()
  })

  it.effect('goes on in another pass past what one pass may replay', () => {
    const Clocks = durable(
      {
        name: 'durable.clocks',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Number,
      },
      (_, d) =>
        Effect.gen(function* () {
          let count = 0
          for (let index = 0; index < 150; index++) {
            yield* d.now(`now:${index}`)
            count += 1
          }
          return count
        }),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Clocks, undefined)
        yield* serve(served(Clocks))
        const { run: done } = yield* records(run.id)
        expect(done.status).toBe('completed')
        expect(done.output).toBe(150)
      }),
    )
  })

  it.effect('opens nothing a finalizer comes to while the body waits', () => {
    const Guarded = durable(
      {
        name: 'durable.guarded',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        tasks: [Draft],
      },
      (_, d) =>
        d
          .task('main', Draft, { id: 'main', hard: false })
          .pipe(
            Effect.ensuring(
              Effect.orDie(
                d.task('cleanup', Draft, { id: 'cleanup', hard: false }),
              ),
            ),
            Effect.asVoid,
          ),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Guarded, undefined)
        yield* coordinate(Guarded.workflows)
        expect((yield* records(run.id)).nodes.map(({ name }) => name)).toEqual([
          'main',
        ])
        yield* serve(served(Guarded))
        expect(yield* admitted(run.id)).toEqual(['main', 'cleanup'])
      }),
    )
  })

  it('describes itself as its runs save it', () => {
    expect(describeDefinition(Review).graphHash).toBe(
      Review.program.definition!.graphHash,
    )
    expect(projectStructure(Review)).toMatchObject({
      mode: 'durable',
      uses: [
        { kind: 'task', name: 'durable.draft' },
        { kind: 'workflow', name: 'durable.fix' },
      ],
    })
  })

  it('refuses two revisions of one target', () => {
    const DraftV2 = task({
      name: Draft.name,
      revision: 'v2',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.void,
    })
    expect(() =>
      durable(
        {
          name: 'durable.two-revisions',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Void,
          tasks: [Draft, DraftV2],
        },
        () => Effect.void,
      ),
    ).toThrow(/more than once/)
  })

  it('needs no services of a worker but those of what it starts', () => {
    const worker: Effect.Effect<never, CleanupTimeout | StorageError, Store> =
      Worker.execution({ workflows: Review.workflows, tasks: Review.tasks })
    expect(worker).toBeDefined()
  })

  it.effect(
    'is not retried in place, even when it failed before any operation',
    () => {
      const Early = durable(
        {
          name: 'durable.early',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Void,
        },
        () => Effect.fail(new Error('refused at once')),
      )
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Early, undefined)
          yield* serve(served(Early))
          expect((yield* records(run.id)).run.status).toBe('failed')
          const refused = yield* Effect.flip(Client.retry(run.id))
          expect(refused._tag).toBe('RunNotRetryable')
        }),
      )
    },
  )

  it.effect(
    'fails a body that waits outside its operations, whatever its finalizers do',
    () => {
      const Stuck = durable(
        {
          name: 'durable.stuck',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Void,
          tasks: [Draft],
        },
        (_, d) =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.orDie(d.task('cleanup', Draft, { id: 'c', hard: false })),
            ),
          ),
      )
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Stuck, undefined)
          yield* serve(served(Stuck))
          const { run: done, nodes } = yield* records(run.id)
          expect(done.status).toBe('failed')
          expect(done.error?.message).toContain('cannot wait')
          expect(nodes).toEqual([])
        }),
      )
    },
  )

  it.effect('is never started by a static step', () => {
    // Types refuse a durable child of a static workflow; code that bypasses
    // them is refused where the run would be started.
    const Static = workflow(
      {
        name: 'durable.static-parent',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
      },
      function* (w) {
        return yield* w.workflow('child', Review as never, {
          input: Effect.succeed({ steps: [] }) as never,
        })
      },
    )
    const { provide } = deployment({ maxDeliveries: 2 })
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Static, undefined)
        yield* serve(served(Static, Review), 120_000)
        const { run: done, children } = yield* records(run.id)
        expect(done.status).toBe('failed')
        expect(done.error?.message).toContain('from a static step')
        expect(
          children.every(({ childRunId }) => childRunId === undefined),
        ).toBe(true)
      }),
    )
  })
})
