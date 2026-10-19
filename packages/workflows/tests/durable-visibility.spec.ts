import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { AnyTask, ServedWorkflow } from '../src/index.ts'
import { Client, durable, task } from '../src/index.ts'
import { durableView } from '../src/inspector.ts'
import { coordinate, deployment, serve } from './typed-support.ts'

const served = (
  ...declared: readonly {
    readonly workflows: readonly ServedWorkflow[]
    readonly tasks: readonly AnyTask[]
  }[]
) => ({
  workflows: [...new Set(declared.flatMap(({ workflows }) => workflows))],
  tasks: [...new Set(declared.flatMap(({ tasks }) => tasks))],
})

const Publish = task({
  name: 'visibility.publish',
  revision: 'v1',
  pool: 'default',
  input: Schema.String,
  output: Schema.String,
  retry: { attempts: 2 },
  handler: (step) => Effect.succeed(`published ${step}`),
})

const Verdict = Schema.Struct({ approved: Schema.Boolean })

const Review = durable(
  {
    name: 'visibility.review',
    revision: 'v1',
    pool: 'default',
    input: Schema.Void,
    output: Schema.Void,
    tasks: [Publish],
    inputs: { verdict: Verdict },
  },
  (_, d) =>
    Effect.gen(function* () {
      yield* d.task('publish:a', Publish, 'a')
      yield* d.input('verdict', 'a')
      yield* d.sleep('cool-off', '1h')
      yield* d.input('verdict', 'b', { timeout: '1d' })
    }),
)

const view = (runId: string) =>
  Effect.map(Client.getDetail(runId, { children: true }), (detail) =>
    durableView(detail!),
  )

describe('a view of a durable run', () => {
  it.effect('shows operations in the order the run took them', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Review, undefined)
        // Sent before the run comes to it: kept, not yet read.
        yield* Client.send(Review, run.id, 'verdict', 'b', { approved: true })
        yield* serve(served(Review))

        const waiting = (yield* view(run.id))!
        expect(waiting.blockers).toEqual([])
        expect(
          waiting.operations.map((operation) => [
            operation.name,
            operation.kind,
            'state' in operation ? operation.state : operation.status,
          ]),
        ).toEqual([
          // The early input was admitted first, when it was sent.
          ['@verdict:b', 'input', 'buffered'],
          ['publish:a', 'task', 'completed'],
          ['@verdict:a', 'input', 'waiting'],
        ])
        const publish = waiting.operations[1]!
        expect(publish).toMatchObject({
          kind: 'task',
          target: { name: Publish.name, revision: 'v1' },
          childRun: { status: 'completed' },
          blocked: false,
        })
        expect(publish.kind === 'task' && publish.attempts?.length).toBe(1)

        yield* Client.send(Review, run.id, 'verdict', 'a', { approved: true })
        yield* serve(served(Review), 2 * 60 * 60_000)
        const done = (yield* view(run.id))!
        expect(done.run.status).toBe('completed')
        const inputs = done.operations.flatMap((operation) =>
          operation.kind === 'input' ? [[operation.key, operation.state]] : [],
        )
        expect(inputs).toEqual([
          ['b', 'received'],
          ['a', 'received'],
        ])
      }),
    )
  })

  it.effect('shows what blocks a run, and what may unblock it', () => {
    const Failing = task({
      name: 'visibility.failing',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.fail(new Error('provider down')),
    })
    const Child = durable(
      {
        name: 'visibility.child',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        tasks: [Failing],
      },
      (_, d) => d.task('call', Failing, undefined),
    )
    const Parent = durable(
      {
        name: 'visibility.parent',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        tasks: [Failing],
        workflows: [Child],
      },
      (_, d) =>
        Effect.asVoid(
          Effect.all(
            [
              d.task('call', Failing, undefined),
              d.workflow('child', Child, undefined),
            ],
            { concurrency: 'unbounded' },
          ),
        ),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Parent, undefined)
        yield* serve(served(Parent))

        const { run: blocked, blockers } = (yield* view(run.id))!
        expect(blocked.status).toBe('blocked')
        const child = blockers.find(({ kind }) => kind === 'child')
        expect(blockers).toEqual([
          {
            kind: 'operation',
            operation: 'call',
            error: expect.objectContaining({ message: 'provider down' }),
            actions: ['resume', 'cancel'],
          },
          {
            kind: 'child',
            operation: 'child',
            childRunId: expect.any(String),
            actions: ['resume'],
          },
        ])
        // The child is found blocked where it is: by status, in the family.
        const { runs } = yield* Client.list({
          rootRunId: run.id,
          status: ['blocked'],
        })
        expect(runs.map(({ id }) => id).sort()).toEqual(
          [run.id, child?.kind === 'child' ? child.childRunId : ''].sort(),
        )
      }),
    )
  })

  it.effect('shows a replay that no longer matches', () => {
    const options = {
      name: 'visibility.mismatch',
      revision: 'v1',
      pool: 'default',
      input: Schema.Void,
      output: Schema.String,
      tasks: [Publish],
    } as const
    const Before = durable(options, (_, d) => d.task('publish', Publish, 'old'))
    const After = durable(options, (_, d) => d.task('publish', Publish, 'new'))
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Before, undefined)
        yield* coordinate(Before.workflows)
        yield* serve(served(After))
        const { blockers } = (yield* view(run.id))!
        expect(blockers).toMatchObject([
          { kind: 'mismatch', error: { name: 'ReplayMismatch' } },
        ])
      }),
    )
  })

  it('is no view of a run with steps', () => {
    expect(
      durableView({
        run: {} as never,
        nodes: [{ name: 'step', kind: 'task' } as never],
        children: [],
        attempts: [],
        childRuns: [],
      }),
    ).toBeUndefined()
  })
})
