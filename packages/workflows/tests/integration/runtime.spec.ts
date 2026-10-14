import { Client, Store, task, Worker, workflow } from '@nmtjs/workflows'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { describe, expect } from 'vitest'

import type { OrderInput } from './fixtures/app.ts'
import { Order, orderOutput, Pack, Stamp } from './fixtures/app.ts'
import {
  ended,
  reached,
  requireServices,
  scenario,
  serve,
  settled,
  targets,
  until,
} from './support.ts'

/**
 * Real workers, as fibers of the test, on real clocks against real servers:
 * what a handler sees of retries, time limits, cancellation and leases.
 */

requireServices()

const text = { input: Schema.String, output: Schema.String }
const fast = { pollMs: 25, concurrency: 8 } as const

/** A run's records come in no order: attempts in the order they were made. */
const inOrder = <A extends { readonly attemptNumber: number }>(
  attempts: readonly A[],
) => attempts.toSorted((a, b) => a.attemptNumber - b.attemptNumber)

const byName = <A extends { readonly name: string }>(records: readonly A[]) =>
  records.toSorted((a, b) => a.name.localeCompare(b.name))

/** Whatever is queued for these routes and not held: claimed, so shown. */
const queued = (names: readonly string[]) =>
  Effect.flatMap(Store, (store) => {
    const routes = names.map((name) => ({ name }))
    return store.claim({
      lanes: [
        { kind: 'continueRun', routes },
        { kind: 'runAttempt', routes },
        { kind: 'runTask', routes },
      ],
      limit: 100,
      leaseMs: 1_000,
    })
  })

for (const target of targets) {
  describe.skipIf(!target.url)(`the runtime on ${target.name}`, () => {
    scenario(
      target,
      'runs a step of every kind, each on the workers of its pool',
      () =>
        Effect.gen(function* () {
          const input: OrderInput = {
            id: 'o1',
            items: ['a', 'b', 'c'],
            express: true,
            hold: 'none',
          }
          const served = { workflows: [Order, Pack], tasks: [Stamp] }
          yield* serve(
            Worker.coordinator({ workflows: served.workflows, ...fast }),
            Worker.execution({ ...served, pool: 'orders', ...fast }),
          )
          const run = yield* Client.start(Order, input)

          // The first task belongs to a pool nobody serves yet: the run
          // waits for it, and its own pool's workers leave it alone.
          const waiting = yield* reached(run.id, 'waiting')
          const [first] = waiting.children.filter(
            ({ nodeName }) => nodeName === 'first',
          )
          yield* Effect.sleep('500 millis')
          expect((yield* Client.get(first!.childRunId!))!.run).toMatchObject({
            kind: 'task',
            name: 'it.stamp',
            status: 'queued',
          })
          expect((yield* Client.get(run.id))!.run.status).toBe('waiting')

          yield* serve(Worker.execution({ ...served, pool: 'stamps', ...fast }))
          const {
            run: done,
            nodes,
            children,
          } = yield* reached(run.id, 'completed')
          expect(done.output).toEqual(orderOutput(input))
          expect(
            byName(nodes).map(({ name, kind, status }) => ({
              name,
              kind,
              status,
            })),
          ).toEqual(
            byName(
              [
                ['prepare', 'activity'],
                ['first', 'task'],
                ['lines', 'mapTask'],
                ['pack', 'workflow'],
                ['parcels', 'mapWorkflow'],
                ['route', 'branch'],
                ['wrap', 'parallel'],
              ].map(([name, kind]) => ({
                name: name!,
                kind,
                status: 'completed',
              })),
            ),
          )
          expect(nodes.find(({ name }) => name === 'route')).toMatchObject({
            selectedCase: 'express',
          })
          expect(
            children
              .filter(({ nodeName }) => nodeName === 'lines')
              .map(({ childKey, status }) => ({ childKey, status }))
              .toSorted((a, b) => a.childKey.localeCompare(b.childKey)),
          ).toEqual(
            input.items.map((_, index) => ({
              childKey: `item:${index}`,
              status: 'completed',
            })),
          )
          const family = yield* Client.getFamily(run.id)
          expect(yield* settled(family.map(({ run }) => run.id))).toEqual({
            dead: [],
            claimed: [],
          })
        }),
    )

    for (const kind of ['mapTask', 'mapWorkflow'] as const) {
      scenario(
        target,
        `keeps a ${kind} at its concurrency limit: never more in flight, and no fewer while items remain`,
        () =>
          Effect.gen(function* () {
            const total = 10
            const limit = 3
            let active = 0
            let started = 0
            let most = 0
            const release = yield* Queue.unbounded<void>()
            // Each item is in flight until the test lets one go.
            const hold = (item: string) =>
              Effect.gen(function* () {
                started += 1
                active += 1
                most = Math.max(most, active)
                yield* Queue.take(release)
                active -= 1
                return item.toUpperCase()
              })
            const Item = task({
              ...text,
              name: 'map.item',
              pool: 'p',
              handler: hold,
            })
            const Child = workflow(
              { ...text, name: 'map.child', pool: 'p' },
              function* (w) {
                return yield* w.activity('work', {
                  ...text,
                  from: w.input,
                  handler: hold,
                })
              },
            )
            const options = {
              item: Schema.String,
              items: Effect.map(Effect.succeed(total), (count) =>
                Array.from({ length: count }, (_, index) => `i${index}`),
              ),
              input: (item: string) => Effect.succeed(item),
              concurrency: limit,
            }
            const Mapped = workflow(
              {
                name: 'map.parent',
                pool: 'p',
                input: Schema.Null,
                output: Schema.Array(Schema.String),
              },
              function* (w) {
                const mapped =
                  kind === 'mapTask'
                    ? yield* w.mapTask('items', Item, options)
                    : yield* w.mapWorkflow('items', Child, options)
                return Effect.map(mapped, ({ items }) =>
                  items.map(({ output }) => output),
                )
              },
            )
            const served = { workflows: [Mapped, Child], tasks: [Item] }
            // More room on the workers than the map may use.
            yield* serve(
              Worker.coordinator({ workflows: served.workflows, ...fast }),
              Worker.execution({ ...served, ...fast }),
              Worker.execution({ ...served, ...fast }),
            )
            const run = yield* Client.start(Mapped, null)

            for (let done = 0; done < total; done++) {
              // Every slot the limit allows is taken before one is freed.
              const expected = Math.min(total, done + limit)
              yield* until(
                `${expected} items to have started`,
                Effect.sync(() => started === expected),
                { details: () => `${started} started, ${active} in flight` },
              )
              expect(active).toBe(expected - done)
              yield* Queue.offer(release, undefined)
              yield* until(
                'an item to end',
                Effect.sync(() => started - active === done + 1),
              )
            }

            const { run: ended } = yield* reached(run.id, 'completed')
            expect(most).toBe(limit)
            expect(started).toBe(total)
            // In the order of the items, whichever finished first.
            expect(ended.output).toEqual(
              Array.from({ length: total }, (_, index) => `I${index}`),
            )
          }),
      )
    }

    scenario(
      target,
      'retries a failing handler after its backoff, and fails the run when the attempts are used up',
      () =>
        Effect.gen(function* () {
          const calls: { input: string; at: number; attempt: number }[] = []
          const failing =
            (until: number) =>
            (input: string, attempt: { attemptNumber: number }) =>
              Effect.suspend(() => {
                calls.push({
                  input,
                  at: Date.now(),
                  attempt: attempt.attemptNumber,
                })
                return attempt.attemptNumber < until
                  ? Effect.fail(new Error(`declined ${attempt.attemptNumber}`))
                  : Effect.succeed(`${input}!`)
              })
          const Flaky = task({
            ...text,
            name: 'retry.task',
            pool: 'p',
            retry: { attempts: 4, backoff: 'exponential', delay: '200ms' },
            handler: failing(4),
          })
          const Retried = workflow(
            { ...text, name: 'retry.flow', pool: 'p' },
            function* (w) {
              const steady = yield* w.activity('steady', {
                ...text,
                from: w.input,
                retry: { attempts: 3, delay: '150ms' },
                handler: failing(3),
              })
              return yield* w.task('flaky', Flaky, { input: steady })
            },
          )
          const Hopeless = task({
            ...text,
            name: 'retry.hopeless',
            pool: 'p',
            retry: { attempts: 2, delay: '100ms' },
            handler: failing(Number.POSITIVE_INFINITY),
          })
          const served = { workflows: [Retried], tasks: [Flaky, Hopeless] }
          yield* serve(
            Worker.coordinator({ workflows: served.workflows, ...fast }),
            Worker.execution({ ...served, ...fast }),
          )

          const run = yield* Client.start(Retried, 'a')
          const {
            run: done,
            attempts,
            children,
          } = yield* reached(run.id, 'completed')
          expect(done.output).toBe('a!!')
          expect(
            inOrder(attempts).map(({ status, attemptNumber, error }) => ({
              status,
              attemptNumber,
              message: error?.message,
            })),
          ).toEqual([
            { status: 'failed', attemptNumber: 1, message: 'declined 1' },
            { status: 'failed', attemptNumber: 2, message: 'declined 2' },
            { status: 'completed', attemptNumber: 3, message: undefined },
          ])
          const flaky = (yield* Client.get(
            children.find(({ nodeName }) => nodeName === 'flaky')!.childRunId!,
          ))!
          expect(inOrder(flaky.attempts).map(({ status }) => status)).toEqual([
            'failed',
            'failed',
            'failed',
            'completed',
          ])

          // No attempt came before its backoff had passed: a fixed delay for
          // the activity, one that doubles for the task. The clocks compared
          // are this process's and the server's, a few milliseconds apart.
          const gaps = (input: string) => {
            const times = calls
              .filter((call) => call.input === input)
              .map(({ at }) => at)
            return times.slice(1).map((at, index) => at - times[index]!)
          }
          const early = 25
          expect(gaps('a')).toHaveLength(2)
          for (const gap of gaps('a')) expect(gap).toBeGreaterThan(150 - early)
          expect(gaps('a!')).toHaveLength(3)
          for (const [index, gap] of gaps('a!').entries()) {
            expect(gap).toBeGreaterThan(200 * 2 ** index - early)
          }

          const lost = yield* Client.start(Hopeless, 'b')
          const failed = yield* reached(lost.id, 'failed')
          expect(failed.run.error).toMatchObject({ message: 'declined 2' })
          expect(failed.attempts.map(({ status }) => status)).toEqual([
            'failed',
            'failed',
          ])
          expect(calls.filter(({ input }) => input === 'b')).toHaveLength(2)
        }),
    )

    scenario(
      target,
      'times an attempt out, interrupts its handler and retries it',
      () =>
        Effect.gen(function* () {
          const seen: string[] = []
          const Slow = workflow(
            { ...text, name: 'timeout.flow', pool: 'p' },
            function* (w) {
              return yield* w.activity('slow', {
                ...text,
                from: w.input,
                timeout: '400ms',
                retry: { attempts: 2 },
                handler: (input, attempt) =>
                  Effect.gen(function* () {
                    // The scope of an attempt ends with it, however it ends.
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() =>
                        seen.push(`released ${attempt.attemptNumber}`),
                      ),
                    )
                    if (attempt.attemptNumber > 1) return `${input} in time`
                    seen.push('started 1')
                    return yield* Effect.onInterrupt(Effect.never, () =>
                      Effect.sync(() => seen.push('interrupted 1')),
                    )
                  }),
              })
            },
          )
          yield* serve(
            Worker.coordinator({ workflows: [Slow], ...fast }),
            Worker.execution({ workflows: [Slow], ...fast }),
          )
          const run = yield* Client.start(Slow, 'a')

          const { run: done, attempts } = yield* reached(run.id, 'completed')
          expect(done.output).toBe('a in time')
          expect(inOrder(attempts)).toMatchObject([
            {
              status: 'timedOut',
              attemptNumber: 1,
              error: { name: 'AttemptTimeout' },
            },
            { status: 'completed', attemptNumber: 2 },
          ])
          const [timedOut] = inOrder(attempts)
          expect(
            timedOut!.completedAt! - timedOut!.dispatchedAt,
          ).toBeGreaterThanOrEqual(400)
          expect(seen).toEqual([
            'started 1',
            'interrupted 1',
            'released 1',
            'released 2',
          ])
        }),
    )

    scenario(
      target,
      'fails a workflow run past its time limit and stops what it had in flight',
      () =>
        Effect.gen(function* () {
          const interrupted = yield* Deferred.make<void>()
          const Limited = workflow(
            { ...text, name: 'limit.flow', pool: 'p', timeout: '1s' },
            function* (w) {
              return yield* w.activity('endless', {
                ...text,
                from: w.input,
                handler: () =>
                  Effect.onInterrupt(Effect.never, () =>
                    Deferred.succeed(interrupted, undefined),
                  ),
              })
            },
          )
          yield* serve(
            Worker.coordinator({
              workflows: [Limited],
              ...fast,
              runTimeouts: { everyMs: 200 },
            }),
            Worker.execution({ workflows: [Limited], ...fast }),
          )
          const run = yield* Client.start(Limited, 'a')

          const { run: failed, attempts } = yield* reached(run.id, 'failed')
          expect(failed.error).toMatchObject({ name: 'RunTimeout' })
          expect(failed.updatedAt - failed.createdAt).toBeGreaterThanOrEqual(
            1_000,
          )
          expect(attempts).toMatchObject([{ status: 'cancelled' }])
          yield* Deferred.await(interrupted).pipe(Effect.timeout('10 seconds'))
        }),
    )

    scenario(
      target,
      'cancels a parent with what it has in flight: handlers are interrupted, a detached child goes on',
      () =>
        Effect.gen(function* () {
          const started = { activity: 0, task: 0, detached: 0 }
          const interrupted: string[] = []
          const finish = yield* Deferred.make<void>()
          const endless = (name: 'activity' | 'task') =>
            Effect.suspend(() => {
              started[name] += 1
              return Effect.onInterrupt(Effect.never, () =>
                Effect.sync(() => interrupted.push(name)),
              )
            })
          const Endless = task({
            ...text,
            name: 'cancel.task',
            pool: 'p',
            retry: { attempts: 3 },
            handler: () => endless('task'),
          })
          const Child = workflow(
            { ...text, name: 'cancel.child', pool: 'p' },
            function* (w) {
              const slow = yield* w.activity('slow', {
                ...text,
                from: w.input,
                retry: { attempts: 3 },
                handler: () => endless('activity'),
              })
              return yield* w.task('never', Endless, { input: slow })
            },
          )
          const Detached = workflow(
            { ...text, name: 'cancel.detached', pool: 'p' },
            function* (w) {
              return yield* w.activity('work', {
                ...text,
                from: w.input,
                handler: (input) =>
                  Effect.suspend(() => {
                    started.detached += 1
                    return Effect.as(Deferred.await(finish), `${input} done`)
                  }),
              })
            },
          )
          const Parent = workflow(
            {
              name: 'cancel.parent',
              pool: 'p',
              input: Schema.String,
              output: Schema.Struct({
                bound: Schema.String,
                task: Schema.String,
                free: Schema.String,
              }),
            },
            function* (w) {
              return yield* w.parallel('all', {
                members: (p) => ({
                  bound: p.workflow(Child, { input: w.input }),
                  task: p.task(Endless, { input: w.input }),
                  free: p.workflow(Detached, {
                    input: w.input,
                    cancellation: 'detach',
                  }),
                }),
              })
            },
          )
          const served = {
            workflows: [Parent, Child, Detached],
            tasks: [Endless],
          }
          yield* serve(
            Worker.coordinator({ workflows: served.workflows, ...fast }),
            Worker.execution({ ...served, ...fast }),
          )
          const run = yield* Client.start(Parent, 'a')
          yield* until(
            'every handler to be running',
            Effect.sync(
              () =>
                started.activity === 1 &&
                started.task === 1 &&
                started.detached === 1,
            ),
          )

          expect((yield* Client.cancel(run.id))?.status).toBe('cancelling')
          const { nodes, children } = yield* reached(run.id, 'cancelled')
          expect(nodes).toMatchObject([{ name: 'all', status: 'cancelled' }])
          const child = (key: string) =>
            children.find(({ childKey }) => childKey === `member:${key}`)!
          const bound = yield* reached(child('bound').childRunId!, 'cancelled')
          expect(bound.nodes).toMatchObject([
            { name: 'slow', status: 'cancelled' },
          ])
          expect(bound.attempts).toMatchObject([{ status: 'cancelled' }])
          yield* reached(child('task').childRunId!, 'cancelled')
          yield* until(
            'both handlers to be interrupted',
            Effect.sync(() => interrupted.length === 2),
          )
          expect(interrupted.toSorted()).toEqual(['activity', 'task'])

          // The detached child was not told: it ends as it would have.
          const free = child('free').childRunId!
          expect((yield* Client.get(free))!.run.status).toBe('running')
          yield* Deferred.succeed(finish, undefined)
          expect((yield* reached(free, 'completed')).run.output).toBe('a done')

          // A cancelled attempt is not a failed one: nothing was retried,
          // and nothing is left to deliver.
          expect(started).toEqual({ activity: 1, task: 1, detached: 1 })
          const family = yield* Client.getFamily(run.id)
          expect(family).toHaveLength(4)
          expect(yield* settled(family.map(({ run }) => run.id))).toEqual({
            dead: [],
            claimed: [],
          })
          expect(
            yield* queued(
              [...served.workflows, Endless].map(({ name }) => name),
            ),
          ).toEqual([])
          expect((yield* Client.get(run.id))!.run).toMatchObject({
            status: 'cancelled',
          })
          expect((yield* Client.get(run.id))!.run.output).toBeUndefined()
        }),
    )

    scenario(
      target,
      'ends a cancelled root only once every workflow run under it has ended',
      () =>
        Effect.gen(function* () {
          const running = yield* Deferred.make<void>()
          const Leaf = workflow(
            { ...text, name: 'nest.leaf', pool: 'p' },
            function* (w) {
              return yield* w.activity('block', {
                ...text,
                from: w.input,
                handler: () =>
                  Deferred.succeed(running, undefined).pipe(
                    Effect.andThen(Effect.never),
                  ),
              })
            },
          )
          const Mid = workflow(
            { ...text, name: 'nest.mid', pool: 'p' },
            function* (w) {
              return yield* w.workflow('leaf', Leaf, { input: w.input })
            },
          )
          const Root = workflow(
            { ...text, name: 'nest.root', pool: 'p' },
            function* (w) {
              return yield* w.workflow('mid', Mid, { input: w.input })
            },
          )
          yield* serve(
            Worker.coordinator({ workflows: [Root, Mid], ...fast }),
            Worker.execution({ workflows: [Leaf], ...fast }),
          )
          // The leaf's passes are coordinated apart, to be held back below.
          const leafScope = yield* Scope.make()
          yield* serve(Worker.coordinator({ workflows: [Leaf], ...fast })).pipe(
            Scope.provide(leafScope),
          )
          const run = yield* Client.start(Root, 'a')
          yield* Deferred.await(running)
          yield* Scope.close(leafScope, Exit.void)

          const statuses = Effect.map(Client.getFamily(run.id), (family) =>
            Object.fromEntries(family.map(({ run }) => [run.name, run.status])),
          )
          const mid = (yield* Client.get(run.id))!.children[0]!.childRunId!
          const leaf = (yield* Client.get(mid))!.children[0]!.childRunId!

          // The mid's pass tells the leaf to cancel; nothing ends the leaf
          // while its passes are not coordinated, so neither run above ends.
          yield* Client.cancel(run.id)
          yield* reached(leaf, 'cancelling')
          yield* Effect.sleep('500 millis')
          expect(yield* statuses).toEqual({
            'nest.root': 'cancelling',
            'nest.mid': 'cancelling',
            'nest.leaf': 'cancelling',
          })

          yield* serve(Worker.coordinator({ workflows: [Leaf], ...fast }))
          // The family is read after the root ended: every run under it
          // ended before the root could.
          yield* ended(run.id)
          expect(yield* statuses).toEqual({
            'nest.root': 'cancelled',
            'nest.mid': 'cancelled',
            'nest.leaf': 'cancelled',
          })
        }),
    )

    scenario(
      target,
      'discards what a handler returns after its run was cancelled',
      () =>
        Effect.gen(function* () {
          const running = yield* Deferred.make<void>()
          const finish = yield* Deferred.make<void>()
          const Late = workflow(
            { ...text, name: 'late.flow', pool: 'p' },
            function* (w) {
              return yield* w.activity('stubborn', {
                ...text,
                from: w.input,
                // It does not yield to interruption, and ends when it will.
                handler: (input) =>
                  Effect.uninterruptible(
                    Deferred.succeed(running, undefined).pipe(
                      Effect.andThen(Deferred.await(finish)),
                      Effect.as(`late ${input}`),
                    ),
                  ),
              })
            },
          )
          yield* serve(
            Worker.coordinator({ workflows: [Late], ...fast }),
            Worker.execution({
              workflows: [Late],
              ...fast,
              cleanupTimeoutMs: 20_000,
            }),
          )
          const run = yield* Client.start(Late, 'a')
          yield* Deferred.await(running)

          yield* Client.cancel(run.id)
          const cancelled = yield* reached(run.id, 'cancelled')
          yield* Deferred.succeed(finish, undefined)
          // The worker lets go of the command once the handler has ended.
          yield* until(
            'the late handler to be let go',
            Effect.map(
              settled([run.id]),
              ({ claimed }) => claimed.length === 0,
            ),
          )

          const after = (yield* Client.get(run.id))!
          expect(after).toEqual(cancelled)
          expect(after.run.output).toBeUndefined()
          expect(after.attempts).toMatchObject([{ status: 'cancelled' }])
          expect(yield* queued([Late.name])).toEqual([])
        }),
    )

    scenario(
      target,
      'stops a handler of a cancelled run at once, long before its next renewal',
      () =>
        Effect.gen(function* () {
          const running = yield* Deferred.make<void>()
          const interrupted = yield* Deferred.make<number>()
          const Held = workflow(
            { ...text, name: 'prompt.flow', pool: 'p' },
            function* (w) {
              return yield* w.activity('hold', {
                ...text,
                from: w.input,
                handler: () =>
                  Deferred.succeed(running, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(interrupted, Date.now()),
                    ),
                  ),
              })
            },
          )
          // A renewal every 100 seconds: only a hint explains a prompt stop.
          const leaseMs = 300_000
          yield* serve(
            Worker.coordinator({ workflows: [Held], ...fast }),
            Worker.execution({ workflows: [Held], ...fast, leaseMs }),
          )
          const run = yield* Client.start(Held, 'a')
          yield* Deferred.await(running)

          const cancelledAt = Date.now()
          yield* Client.cancel(run.id)
          const stoppedAt = yield* Deferred.await(interrupted).pipe(
            Effect.timeout('20 seconds'),
          )
          expect(stoppedAt - cancelledAt).toBeLessThan(20_000)
          yield* reached(run.id, 'cancelled')
        }),
    )

    scenario(
      target,
      'keeps a handler that outlasts its lease its own: no other worker runs it meanwhile',
      () =>
        Effect.gen(function* () {
          let calls = 0
          const leaseMs = 1_500
          const Long = workflow(
            { ...text, name: 'long.flow', pool: 'p' },
            function* (w) {
              return yield* w.activity('long', {
                ...text,
                from: w.input,
                handler: (input) =>
                  Effect.suspend(() => {
                    calls += 1
                    // Three leases long.
                    return Effect.as(Effect.sleep(leaseMs * 3), `${input} done`)
                  }),
              })
            },
          )
          const worker = Worker.execution({
            workflows: [Long],
            pollMs: 25,
            leaseMs,
          })
          yield* serve(
            Worker.coordinator({ workflows: [Long], ...fast }),
            worker,
            worker,
            worker,
          )
          const run = yield* Client.start(Long, 'a')

          const { run: done, attempts } = yield* reached(run.id, 'completed')
          expect(done.output).toBe('a done')
          expect(calls).toBe(1)
          expect(attempts).toMatchObject([
            { status: 'completed', attemptNumber: 1 },
          ])
          expect(
            attempts[0]!.completedAt! - attempts[0]!.dispatchedAt,
          ).toBeGreaterThanOrEqual(leaseMs * 3 - 25)
        }),
    )

    scenario(
      target,
      'answers concurrent starts of one idempotency key with one run, worked once',
      () =>
        Effect.gen(function* () {
          let calls = 0
          const Once = workflow(
            { ...text, name: 'once.flow', pool: 'p' },
            function* (w) {
              return yield* w.activity('work', {
                ...text,
                from: w.input,
                handler: (input) => Effect.sync(() => `${input} ${++calls}`),
              })
            },
          )
          const worker = { workflows: [Once], pollMs: 25, concurrency: 2 }
          yield* serve(
            ...Array.from({ length: 4 }, () => Worker.coordinator(worker)),
            ...Array.from({ length: 4 }, () => Worker.execution(worker)),
          )

          const starts = yield* Effect.all(
            Array.from({ length: 20 }, () =>
              Client.start(Once, 'a', { idempotencyKey: ['once', 'a'] }),
            ),
            { concurrency: 'unbounded' },
          )
          expect(new Set(starts.map(({ id }) => id)).size).toBe(1)
          const { run } = yield* reached(starts[0]!.id, 'completed')
          expect(run.output).toBe('a 1')
          expect((yield* Client.list()).runs.map(({ id }) => id)).toEqual([
            run.id,
          ])
          // Another input under the key is another request, and refused.
          expect(
            yield* Effect.flip(
              Client.start(Once, 'b', { idempotencyKey: ['once', 'a'] }),
            ),
          ).toMatchObject({ _tag: 'IdempotencyConflict', runId: run.id })
          expect(calls).toBe(1)
        }),
    )

    scenario(
      target,
      'shows a delayed start at once and works it no sooner than it is due',
      () =>
        Effect.gen(function* () {
          let ranAt: number | undefined
          const Delayed = task({
            ...text,
            name: 'delayed.task',
            pool: 'p',
            handler: (input) =>
              Effect.sync(() => {
                ranAt = Date.now()
                return input
              }),
          })
          yield* serve(Worker.execution({ tasks: [Delayed], ...fast }))
          // Idle workers must find it by polling: no hint says when it is due.
          const startAt = Date.now() + 2_000
          const run = yield* Client.start(Delayed, 'a', { startAt })

          expect((yield* Client.get(run.id))!.run.status).toBe('queued')
          expect((yield* Client.list({ status: 'queued' })).runs).toHaveLength(
            1,
          )
          const done = yield* ended(run.id)
          expect(done.run).toMatchObject({ status: 'completed', output: 'a' })
          // The server's clock decides; it is a few milliseconds from ours.
          expect(ranAt! - startAt).toBeGreaterThan(-25)
        }),
    )
  })
}
