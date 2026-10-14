import { Client, task, Worker, workflow } from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { describe, expect } from 'vitest'

import { generation, Host, revisionOutput } from './fixtures/app.ts'
import {
  reached,
  requireServices,
  scenario,
  serve,
  settled,
  targets,
  until,
} from './support.ts'

/**
 * What an operator does after real failures: retry a run in place, restart
 * it as a new one, and queue again a command that was set aside.
 */

requireServices()

const text = { input: Schema.String, output: Schema.String }
const fast = { pollMs: 25, concurrency: 4 } as const

for (const target of targets) {
  describe.skipIf(!target.url)(`operations on ${target.name}`, () => {
    scenario(
      target,
      'retries a failed run in place, running again only what failed, and restarts it as a new run',
      () =>
        Effect.gen(function* () {
          let broken = true
          const calls: string[] = []
          const call = (name: string) => Effect.sync(() => calls.push(name))
          const Item = task({
            ...text,
            name: 'ops.item',
            pool: 'p',
            retry: { attempts: 2 },
            handler: (item) =>
              Effect.gen(function* () {
                yield* call(`item ${item}`)
                if (broken && item === 'b') {
                  return yield* Effect.fail(new Error(`cannot ${item}`))
                }
                return item.toUpperCase()
              }),
          })
          const Flow = workflow(
            {
              name: 'ops.flow',
              pool: 'p',
              input: Schema.Array(Schema.String),
              output: Schema.String,
            },
            function* (w) {
              const prepared = yield* w.activity('prepare', {
                input: Schema.Array(Schema.String),
                output: Schema.Number,
                from: w.input,
                handler: (items) => Effect.as(call('prepare'), items.length),
              })
              const mapped = yield* w.mapTask('items', Item, {
                item: Schema.String,
                items: w.input,
                input: (item) => Effect.succeed(item),
              })
              return yield* w.activity('finish', {
                input: Schema.String,
                output: Schema.String,
                from: Effect.gen(function* () {
                  const { items } = yield* mapped
                  return `${yield* prepared}:${items.map(({ output }) => output).join('')}`
                }),
                handler: (summary) => Effect.as(call('finish'), summary),
              })
            },
          )
          const served = { workflows: [Flow], tasks: [Item] }
          yield* serve(
            Worker.coordinator({ workflows: served.workflows, ...fast }),
            Worker.execution({ ...served, ...fast }),
          )

          const run = yield* Client.start(Flow, ['a', 'b', 'c'])
          const failed = yield* reached(run.id, 'failed')
          expect(failed.run.error).toMatchObject({ message: 'cannot b' })
          expect(calls.toSorted()).toEqual(
            ['prepare', 'item a', 'item b', 'item b', 'item c'].toSorted(),
          )

          // An operator who looked at an older version of it is refused.
          expect(
            yield* Effect.flip(
              Client.retry(run.id, { expectedVersion: failed.run.version - 1 }),
            ),
          ).toMatchObject({ _tag: 'StaleRunVersion' })

          broken = false
          calls.length = 0
          const reopened = yield* Client.retry(run.id, {
            expectedVersion: failed.run.version,
          })
          expect(reopened).toMatchObject({ id: run.id })
          const { run: done, children } = yield* reached(run.id, 'completed')
          expect(done.output).toBe('3:ABC')
          // Only the item that failed ran again, with a fresh budget, and
          // what came after it ran for the first time.
          expect(calls.toSorted()).toEqual(['finish', 'item b'])
          const b = children.find(({ childKey }) => childKey === 'item:1')!
          const { attempts } = (yield* Client.get(b.childRunId!))!
          expect(
            attempts
              .map(({ status, attemptNumber, retryAttemptNumber }) => ({
                status,
                attemptNumber,
                retryAttemptNumber,
              }))
              .toSorted((x, y) => x.attemptNumber - y.attemptNumber),
          ).toEqual([
            { status: 'failed', attemptNumber: 1, retryAttemptNumber: 1 },
            { status: 'failed', attemptNumber: 2, retryAttemptNumber: 2 },
            { status: 'completed', attemptNumber: 3, retryAttemptNumber: 1 },
          ])
          expect(yield* Effect.flip(Client.retry(run.id))).toMatchObject({
            _tag: 'RunNotFailed',
          })

          // A restart is a new run of the stored input: all of it runs.
          calls.length = 0
          const restarted = yield* Client.restart(run.id, {
            definitions: [Flow],
          })
          expect(restarted.id).not.toBe(run.id)
          expect(restarted.input).toEqual(['a', 'b', 'c'])
          const again = yield* reached(restarted.id, 'completed')
          expect(again.run.output).toBe('3:ABC')
          expect(calls.toSorted()).toEqual(
            ['prepare', 'item a', 'item b', 'item c', 'finish'].toSorted(),
          )
          expect((yield* Client.get(run.id))!.run).toEqual(done)
        }),
    )

    scenario(
      target,
      'refuses to retry a run while any of its family is still in flight, and retries it once all has ended',
      () =>
        Effect.gen(function* () {
          let slow = true
          const Child = workflow(
            { ...text, name: 'ops.child', pool: 'p' },
            function* (w) {
              return yield* w.activity('work', {
                ...text,
                from: w.input,
                handler: (input) =>
                  Effect.as(
                    slow ? Effect.sleep('2 seconds') : Effect.void,
                    `${input} done`,
                  ),
              })
            },
          )
          // It fails when its time is up, and leaves the child it detached
          // to go on.
          const Limited = workflow(
            { ...text, name: 'ops.limited', pool: 'p', timeout: '500ms' },
            function* (w) {
              return yield* w.workflow('child', Child, {
                input: w.input,
                cancellation: 'detach',
              })
            },
          )
          const served = { workflows: [Limited, Child] }
          yield* serve(
            Worker.coordinator({
              workflows: served.workflows,
              ...fast,
              runTimeouts: { everyMs: 100 },
            }),
            Worker.execution({ ...served, ...fast }),
          )
          const run = yield* Client.start(Limited, 'x')
          const failed = yield* reached(run.id, 'failed')
          expect(failed.run.error).toMatchObject({ name: 'RunTimeout' })
          const [child] = failed.children
          expect((yield* Client.get(child!.childRunId!))!.run.status).toBe(
            'running',
          )

          expect(yield* Effect.flip(Client.retry(run.id))).toMatchObject({
            _tag: 'RunBusy',
            busyRunId: child!.childRunId,
          })
          yield* reached(child!.childRunId!, 'completed')
          slow = false
          yield* Client.retry(run.id)
          const { run: done } = yield* reached(run.id, 'completed')
          expect(done.output).toMatch(/^x done$/)
          expect(yield* settled([run.id])).toEqual({ dead: [], claimed: [] })
        }),
    )

    scenario(
      target,
      'sets aside a command no worker can work, and runs it once it is queued again where one can',
      () =>
        Effect.gen(function* () {
          const v1 = generation('v1', 'io')
          const drifted = generation('v1', 'io', { reshaped: true })
          const run = yield* Client.start(v1.Parent, 'x')

          // Code edited under the revision: every delivery is given back,
          // until the store sets the command aside. No reaper ends the run.
          const wrong = yield* Effect.forkScoped(
            Worker.coordinator({
              workflows: drifted.workflows,
              ...fast,
              reaping: false,
            }),
          )
          const [dead] = yield* until(
            'the command to be set aside',
            Effect.map(
              Client.listDeadCommands({ runId: run.id }),
              ({ commands }) => commands.length > 0 && commands,
            ),
          )
          expect(dead).toMatchObject({
            command: { kind: 'continueRun', runId: run.id },
            deliveries: 2,
            error: { name: 'DefinitionConflict' },
          })
          yield* Fiber.interrupt(wrong)

          // The right code is deployed: a dead command waits all the same.
          yield* serve(
            Worker.coordinator({ workflows: v1.workflows, ...fast }),
            Worker.execution({ ...v1, ...fast }).pipe(
              Effect.provideService(Host, { pool: 'io' }),
            ),
          )
          yield* Effect.sleep('1 second')
          expect((yield* Client.get(run.id))!.run.status).toBe('queued')

          // Of two operators who queue it again, one does.
          const requeued = yield* Effect.all(
            [
              Client.requeueDeadCommand(dead!.id),
              Client.requeueDeadCommand(dead!.id),
            ],
            { concurrency: 'unbounded' },
          )
          expect(requeued.filter(Boolean)).toEqual([true])
          const { run: done } = yield* reached(run.id, 'completed')
          expect(done.output).toEqual(revisionOutput('x', 'v1'))
          expect(yield* Client.listDeadCommands()).toEqual({ commands: [] })
        }),
      { maxDeliveries: 2 },
    )
  })
}
