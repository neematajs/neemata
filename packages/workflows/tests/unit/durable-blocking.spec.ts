import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { AnyTask, ServedWorkflow } from '../../src/index.ts'
import { Client, durable, task, Worker, workflow } from '../../src/index.ts'
import { elapse, idle } from '../support.ts'
import { coordinate, deployment, serve } from '../typed-support.ts'

const served = (
  ...declared: readonly {
    readonly workflows: readonly ServedWorkflow[]
    readonly tasks: readonly AnyTask[]
  }[]
) => ({
  workflows: [...new Set(declared.flatMap(({ workflows }) => workflows))],
  tasks: [...new Set(declared.flatMap(({ tasks }) => tasks))],
})

const records = (runId: string) =>
  Effect.map(Client.get(runId), (found) => found!)

/** A task that fails until it is told the provider is back. */
function provider() {
  const state = { healthy: false, keys: [] as string[] }
  const Call = task({
    name: 'blocking.call',
    revision: 'v1',
    pool: 'default',
    input: Schema.String,
    output: Schema.String,
    handler: (subject, attempt) =>
      Effect.suspend(() => {
        state.keys.push(attempt.idempotencyKey)
        return state.healthy
          ? Effect.succeed(`done ${subject}`)
          : Effect.fail(new Error('provider down'))
      }),
  })
  return { state, Call }
}

const Echo = task({
  name: 'blocking.echo',
  revision: 'v1',
  pool: 'default',
  input: Schema.String,
  output: Schema.String,
  handler: (text) => Effect.succeed(text),
})

describe('blocking durable runs', () => {
  it.effect('blocks on failed work, goes on elsewhere, and resumes it', () => {
    const { state, Call } = provider()
    const Flow = durable(
      {
        name: 'blocking.flow',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Array(Schema.String),
        tasks: [Call, Echo],
      },
      (_, d) =>
        Effect.all(
          [
            // The default `block`: the catch below never sees the failure.
            d
              .task('call', Call, 'a')
              .pipe(
                Effect.catchTag('OperationFailed', () =>
                  Effect.succeed('caught'),
                ),
              ),
            d.task('echo', Echo, 'b'),
          ],
          { concurrency: 'unbounded' },
        ),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Flow, undefined)
        yield* serve(served(Flow))

        const blocked = yield* records(run.id)
        expect(blocked.run.status).toBe('blocked')
        const call = blocked.nodes.find(({ name }) => name === 'call')!
        expect(call.operation?.blocked).toBe(true)
        // The other branch went on.
        expect(blocked.nodes.find(({ name }) => name === 'echo')?.status).toBe(
          'completed',
        )

        state.healthy = true
        const resumed = yield* Client.resume(run.id, {
          expectedVersion: blocked.run.version,
        })
        expect(resumed.status).toBe('waiting')
        yield* serve(served(Flow))

        const { run: done, children } = yield* records(run.id)
        expect(done.status).toBe('completed')
        expect(done.output).toEqual(['done a', 'b'])
        // The same task run again, under one idempotency key throughout.
        const callChild = children.find(({ nodeName }) => nodeName === 'call')!
        expect(callChild.childRunId).toBe(
          blocked.children.find(({ nodeName }) => nodeName === 'call')!
            .childRunId,
        )
        expect(new Set(state.keys).size).toBe(1)
        expect(state.keys.length).toBe(2)
      }),
    )
  })

  it.effect('gives the failure to a body that handles it', () => {
    const { Call } = provider()
    const Handled = durable(
      {
        name: 'blocking.handled',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Call],
      },
      (_, d) =>
        d
          .task('call', Call, 'a', { onFailure: 'fail' })
          .pipe(
            Effect.catchTag('OperationFailed', () => Effect.succeed('caught')),
          ),
    )
    const Failing = durable(
      {
        name: 'blocking.failing',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Call],
        onFailure: 'fail',
      },
      (_, d) => d.task('call', Call, 'a'),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const handled = yield* Client.start(Handled, undefined)
        const failing = yield* Client.start(Failing, undefined)
        yield* serve(served(Handled, Failing))
        expect((yield* records(handled.id)).run.output).toBe('caught')
        expect((yield* records(failing.id)).run.status).toBe('failed')
      }),
    )
  })

  it.effect(
    'refuses to block on a durable child, whose failure is final',
    () => {
      const Child = durable(
        {
          name: 'blocking.child',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Void,
        },
        () => Effect.fail(new Error('child decided')),
      )
      const Parent = durable(
        {
          name: 'blocking.parent',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.String,
          workflows: [Child],
        },
        (_, d) =>
          Effect.gen(function* () {
            // Its default: the failure reaches the body.
            const caught = yield* d.workflow('child', Child, undefined).pipe(
              Effect.as('ran'),
              Effect.catchTag('OperationFailed', () =>
                Effect.succeed('caught'),
              ),
            )
            yield* d.workflow('again', Child, undefined, { onFailure: 'block' })
            return caught
          }),
      )
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Parent, undefined)
          yield* serve(served(Parent))
          const { run: done } = yield* records(run.id)
          expect(done.status).toBe('failed')
          expect(done.error?.message).toContain(
            "a durable child's failure is final",
          )
        }),
      )
    },
  )

  it.effect('resumes a failed static child workflow as itself', () => {
    const { state, Call } = provider()
    const Static = workflow(
      {
        name: 'blocking.static',
        revision: 'v1',
        pool: 'default',
        input: Schema.String,
        output: Schema.String,
      },
      function* (w) {
        return yield* w.task('call', Call, { input: w.input })
      },
    )
    const Parent = durable(
      {
        name: 'blocking.static-parent',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        workflows: [Static],
      },
      (_, d) => d.workflow('child', Static, 'x'),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Parent, undefined)
        yield* serve(served(Parent))
        expect((yield* records(run.id)).run.status).toBe('blocked')
        state.healthy = true
        yield* Client.resume(run.id)
        yield* serve(served(Parent))
        expect((yield* records(run.id)).run.output).toBe('done x')
      }),
    )
  })

  it.effect('refuses a resume decided on another view of the run', () => {
    const { state, Call } = provider()
    const Two = durable(
      {
        name: 'blocking.two',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        tasks: [Call],
      },
      (_, d) =>
        Effect.asVoid(
          Effect.all([d.task('a', Call, 'a'), d.task('b', Call, 'b')], {
            concurrency: 'unbounded',
          }),
        ),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Two, undefined)
        const notYet = yield* Effect.flip(Client.resume(run.id))
        expect(notYet._tag).toBe('RunNotBlocked')
        yield* serve(served(Two))

        const { run: blocked } = yield* records(run.id)
        expect(blocked.status).toBe('blocked')
        const stale = yield* Effect.flip(
          Client.resume(run.id, { expectedVersion: blocked.version - 1 }),
        )
        expect(stale._tag).toBe('StaleRunVersion')
        const unknown = yield* Effect.flip(
          Client.resume(run.id, { blockers: ['c'] }),
        )
        expect(unknown).toMatchObject({
          _tag: 'BlockerNotResumable',
          reason: 'not-blocked',
        })

        // One of the two: the run stays blocked on the other.
        state.healthy = true
        const partly = yield* Client.resume(run.id, { blockers: ['a'] })
        expect(partly.status).toBe('blocked')
        yield* serve(served(Two))
        expect((yield* records(run.id)).run.status).toBe('blocked')
        yield* Client.resume(run.id, { blockers: ['b'] })
        yield* serve(served(Two))
        expect((yield* records(run.id)).run.status).toBe('completed')
      }),
    )
  })

  it.effect(
    'blocks on a replay mismatch until resumed with code that matches',
    () => {
      const options = {
        name: 'blocking.mismatch',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Echo],
      } as const
      const Before = durable(options, (_, d) => d.task('echo', Echo, 'old'))
      const Broken = durable(options, (_, d) => d.task('echo', Echo, 'new'))
      const { provide } = deployment()
      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Before, undefined)
          yield* coordinate(Before.workflows)
          // Code that asks otherwise is deployed under the same revision.
          yield* serve(served(Broken))
          const blocked = yield* records(run.id)
          expect(blocked.run.status).toBe('blocked')
          expect(blocked.run.error?.name).toBe('ReplayMismatch')

          // Resumed under the broken code: blocked again.
          yield* Client.resume(run.id)
          yield* serve(served(Broken))
          expect((yield* records(run.id)).run.status).toBe('blocked')

          // The fix deployed, and resumed: it goes on as it was.
          yield* Client.resume(run.id)
          yield* serve(served(Before))
          const { run: done } = yield* records(run.id)
          expect(done.status).toBe('completed')
          expect(done.output).toBe('old')
          expect(done.error).toBeUndefined()
        }),
      )
    },
  )

  it.effect('is cancelled while blocked', () => {
    const { Call } = provider()
    const Stuck = durable(
      {
        name: 'blocking.cancel',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Call],
      },
      (_, d) => d.task('call', Call, 'a'),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Stuck, undefined)
        yield* serve(served(Stuck))
        expect((yield* records(run.id)).run.status).toBe('blocked')
        yield* Client.cancel(run.id)
        yield* serve(served(Stuck))
        expect((yield* records(run.id)).run.status).toBe('cancelled')
      }),
    )
  })

  it.effect('times out a blocked run', () => {
    const { Call } = provider()
    const Deadline = durable(
      {
        name: 'blocking.deadline',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Call],
        timeout: '2m',
      },
      (_, d) => d.task('call', Call, 'a'),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Deadline, undefined)
        yield* serve(served(Deadline))
        expect((yield* records(run.id)).run.status).toBe('blocked')
        yield* serve(served(Deadline), 4 * 60_000)
        const { run: done } = yield* records(run.id)
        expect(done.status).toBe('failed')
        expect(done.error?.name).toBe('RunTimeout')
      }),
    )
  })

  it.effect('lets go of a block the body no longer waits on', () => {
    const { Call } = provider()
    const Fallback = durable(
      {
        name: 'blocking.fallback',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Call],
        inputs: { override: Schema.String, next: Schema.String },
      },
      (_, d) =>
        Effect.gen(function* () {
          // Whichever comes first: the work, or an answer given by hand.
          const first = yield* Effect.raceFirst(
            d.task('call', Call, 'a'),
            d.input('override', 'a'),
          )
          const next = yield* d.input('next', 'b')
          return `${first} ${next}`
        }),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Fallback, undefined)
        yield* serve(served(Fallback))
        expect((yield* records(run.id)).run.status).toBe('blocked')

        yield* Client.send(Fallback, run.id, 'override', 'a', 'by hand')
        yield* serve(served(Fallback))
        const { run: waiting, nodes } = yield* records(run.id)
        expect(waiting.status).toBe('waiting')
        expect(
          nodes.find(({ name }) => name === 'call')?.operation?.blocked,
        ).toBeUndefined()
        const refused = yield* Effect.flip(Client.resume(run.id))
        expect(refused._tag).toBe('RunNotBlocked')
      }),
    )
  })

  it.effect('refuses to resume work a handler of which is still ending', () => {
    // Only the first attempt is slow to stop, so the test's own end is not.
    let slow = true
    const Stuck = workflow(
      {
        name: 'blocking.stuck',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        // Fails the run from outside its work, which goes on ending.
        timeout: '30s',
      },
      function* (w) {
        return yield* w.activity('hang', {
          input: Schema.Void,
          output: Schema.Void,
          from: w.input,
          // Slow to stop: its cleanup outlasts the run it was for.
          handler: () =>
            Effect.onInterrupt(Effect.never, () =>
              slow ? Effect.sleep('5 seconds') : Effect.void,
            ),
        })
      },
    )
    const Parent = durable(
      {
        name: 'blocking.stuck-parent',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Void,
        workflows: [Stuck],
      },
      (_, d) => d.workflow('child', Stuck, undefined),
    )
    const { provide } = deployment()
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Client.start(Parent, undefined)
          const { workflows, tasks } = served(Parent)
          yield* Effect.forkScoped(
            Worker.coordinator({ workflows, pollMs: 1_000 }),
          )
          yield* Effect.forkScoped(
            Worker.execution({ workflows, tasks, pollMs: 1_000 }),
          )
          yield* idle
          // Just past the sweep that times the child out, its handler still
          // cleaning up.
          yield* elapse(62_000)

          expect((yield* records(started.id)).run.status).toBe('blocked')
          // The activity's handler still runs, under its worker's claim.
          const busy = yield* Effect.flip(Client.resume(started.id))
          expect(busy._tag).toBe('RunBusy')
          // Once it has stopped, the work runs again.
          yield* elapse(30_000)
          slow = false
          const resumed = yield* Client.resume(started.id)
          expect(resumed.status).toBe('waiting')
        }),
      ),
    )
  })
})
