import type { RunRecords } from '@nmtjs/workflows'
import { Client } from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import { describe, expect } from 'vitest'

import type { OrderInput } from './fixtures/app.ts'
import type { StoreSpec } from './fixtures/store.ts'
import type { WorkerConfig } from './fixtures/worker.ts'
import type { Workspace } from './support.ts'
import { Order, orderOutput, orderSteps } from './fixtures/app.ts'
import {
  reached,
  requireServices,
  scenario,
  settled,
  spawnWorker,
  targets,
  until,
  workspace,
} from './support.ts'

/**
 * Workers as processes of their own, killed, frozen and stopped under their
 * work. What must hold afterwards is what a user reads: the run completes,
 * and its records say that every piece of work was done once.
 */

requireServices()

const order = (
  id: string,
  hold: OrderInput['hold'] = 'none',
  express = false,
): OrderInput => ({ id, items: ['a', 'b', 'c'], express, hold })

/** A process with both roles, serving `Order` and all it starts. */
const worker = (spec: StoreSpec, leaseMs: number): WorkerConfig => ({
  store: spec,
  served: ['order'],
  coordinator: { concurrency: 4, leaseMs, pollMs: 25 },
  execution: [{ concurrency: 4, leaseMs, pollMs: 25 }],
})

/** The steps whose handlers ran to their end, as often as each did. */
const ran = (ws: Workspace) =>
  Effect.map(ws.events, (events) =>
    events
      .filter(({ event }) => event === 'ran')
      .map(({ step }) => step as string)
      .toSorted(),
  )

/**
 * A completed run of `Order` whose records hold every piece of work once:
 * one attempt for each activity, one run for each task and child workflow,
 * all completed, and nothing left queued, held or set aside.
 */
const completedOnce = Effect.fnUntraced(function* (
  { run, attempts, children }: RunRecords,
  input: OrderInput,
) {
  expect(run).toMatchObject({ status: 'completed', output: orderOutput(input) })
  // The activities of the run itself: no crash made a second attempt.
  expect(
    attempts
      .map(({ nodeName, childKey, status, attemptNumber }) => ({
        nodeName,
        childKey,
        status,
        attemptNumber,
      }))
      .toSorted((a, b) => a.nodeName.localeCompare(b.nodeName)),
  ).toEqual(
    [
      ['prepare', '$self'],
      ...(input.express ? [] : [['route', 'case:standard']]),
      ['wrap', 'member:label'],
    ].map(([nodeName, childKey]) => ({
      nodeName,
      childKey,
      status: 'completed',
      attemptNumber: 1,
    })),
  )
  expect(children.every(({ status }) => status === 'completed')).toBe(true)

  const family = yield* Client.getFamily(run.id)
  // The run, the tasks `first` and `receipt`, a line and a parcel for each
  // item, the `pack` workflow, and the task of the express route.
  expect(family).toHaveLength(
    4 + 2 * input.items.length + (input.express ? 1 : 0),
  )
  for (const member of family) {
    expect(member.run.status).toBe('completed')
    if (member.run.id === run.id) continue
    // A task run and a child workflow have one attempt each as well.
    expect(
      (yield* Client.get(member.run.id))!.attempts.map(({ status }) => status),
    ).toEqual(['completed'])
  }
  expect(yield* settled(family.map(({ run }) => run.id))).toEqual({
    dead: [],
    claimed: [],
  })
})

for (const target of targets) {
  describe.skipIf(!target.url)(`recovery on ${target.name}`, () => {
    scenario(
      target,
      'redelivers the attempts of a worker killed in the middle of its activities, once their leases end',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const leaseMs = 2_000
          const inputs = [order('k1', 'activity'), order('k2', 'activity')]
          const doomed = yield* spawnWorker(worker(spec, leaseMs), ws)
          const runs = yield* Effect.forEach(inputs, (input) =>
            Client.start(Order, input),
          )
          for (const { id } of inputs) {
            yield* until(
              `the activity of ${id} to be held`,
              ws.held(`${id}.activity`),
              { details: doomed.output },
            )
          }

          // A second worker looks for work all along. For longer than a
          // lease lasts it finds none: the first one renews what it holds.
          const rescuer = yield* spawnWorker(worker(spec, leaseMs), ws)
          yield* Effect.sleep(leaseMs * 2)
          expect(yield* ran(ws)).toEqual([])
          for (const run of runs) {
            const records = (yield* Client.get(run.id))!
            expect(records.run.status).toBe('running')
            expect(records.attempts).toMatchObject([
              { nodeName: 'prepare', status: 'started', attemptNumber: 1 },
            ])
          }

          doomed.signal('SIGKILL')
          expect(yield* doomed.exited).toEqual({
            code: null,
            signal: 'SIGKILL',
          })

          for (const [index, run] of runs.entries()) {
            const records = yield* reached(run.id, 'completed', {
              details: rescuer.output,
            })
            yield* completedOnce(records, inputs[index]!)
          }
          // The handlers that were killed never got to their end, and every
          // other ran once.
          expect(yield* ran(ws)).toEqual(inputs.flatMap(orderSteps).toSorted())
        }),
    )

    scenario(
      target,
      'finishes a run whose coordinator was killed in the middle of a pass',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const input = order('p1', 'pass')
          const doomed = yield* spawnWorker(worker(spec, 2_000), ws)
          const run = yield* Client.start(Order, input)
          // The pass that would start `route` blocks while it selects the
          // case, with everything it decided still uncommitted.
          yield* until('the pass to be stalled', ws.held('p1.pass'), {
            details: doomed.output,
          })
          const before = (yield* Client.get(run.id))!
          expect(before.run.status).not.toBe('completed')
          expect(
            before.children.filter(({ nodeName }) => nodeName === 'route'),
          ).toEqual([])
          const stepsBefore = yield* ran(ws)

          doomed.signal('SIGKILL')
          expect(yield* doomed.exited).toEqual({
            code: null,
            signal: 'SIGKILL',
          })
          // Nothing of the pass was written.
          expect((yield* Client.get(run.id))!).toEqual(before)

          const rescuer = yield* spawnWorker(worker(spec, 2_000), ws)
          const records = yield* reached(run.id, 'completed', {
            details: rescuer.output,
          })
          yield* completedOnce(records, input)
          // No handler ran again for the pass that was lost: what had run
          // before the kill is there once, with what ran after it.
          const steps = yield* ran(ws)
          expect(steps).toEqual(orderSteps(input))
          expect(steps).toEqual(expect.arrayContaining(stepsBefore))
        }),
    )

    scenario(
      target,
      'hands the work of a worker that is stopped to another at once',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          // Far longer than the test waits: only a hand-over explains a run
          // that goes on.
          const leaseMs = 120_000
          const input = order('g1', 'activity')
          const stopping = yield* spawnWorker(worker(spec, leaseMs), ws)
          const run = yield* Client.start(Order, input)
          yield* until('the activity to be held', ws.held('g1.activity'), {
            details: stopping.output,
          })
          const next = yield* spawnWorker(worker(spec, leaseMs), ws)

          stopping.signal('SIGTERM')
          // It ended by itself, as a main fiber that was interrupted does.
          expect(yield* stopping.exited, stopping.output()).toEqual({
            code: 130,
            signal: null,
          })
          const records = yield* reached(run.id, 'completed', {
            timeoutMs: 30_000,
            details: next.output,
          })

          yield* completedOnce(records, input)
          // The handler was interrupted, not abandoned, and ran again whole.
          const events = yield* ws.events
          expect(
            events.filter(({ event }) => event === 'interrupted'),
          ).toMatchObject([{ name: 'g1.activity', pid: stopping.pid }])
          expect(
            events.find(({ step }) => step === 'g1:prepare'),
          ).toMatchObject({ pid: next.pid })
        }),
    )

    scenario(
      target,
      'lets another worker finish what a frozen one held, and discards what the frozen one does when it wakes',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const input = order('f1', 'activity')
          const frozen = yield* spawnWorker(worker(spec, 2_000), ws)
          const run = yield* Client.start(Order, input)
          yield* until('the activity to be held', ws.held('f1.activity'), {
            details: frozen.output,
          })

          // Stopped, it renews nothing; nor does it know it lost its claim.
          frozen.signal('SIGSTOP')
          const taker = yield* spawnWorker(worker(spec, 2_000), ws)
          const records = yield* reached(run.id, 'completed', {
            details: taker.output,
          })
          yield* completedOnce(records, input)

          frozen.signal('SIGCONT')
          // It learns at its next renewal, and stops its handler.
          yield* until(
            'the stale handler to be interrupted',
            Effect.map(ws.events, (events) =>
              events.some(
                ({ event, pid }) =>
                  event === 'interrupted' && pid === frozen.pid,
              ),
            ),
            { details: frozen.output },
          )
          expect((yield* Client.get(run.id))!).toEqual(records)
          expect(yield* ran(ws)).toEqual(orderSteps(input))

          // It lost one claim, not its place: it works what comes next.
          taker.signal('SIGKILL')
          yield* taker.exited
          const second = order('f2')
          const again = yield* Client.start(Order, second)
          yield* completedOnce(
            yield* reached(again.id, 'completed', { details: frozen.output }),
            second,
          )
        }),
    )

    scenario(
      target,
      'runs every handler once when several processes race for the same runs',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const inputs = Array.from({ length: 12 }, (_, index) =>
            order(`r${index}`, 'none', index % 2 === 0),
          )
          const workers = yield* Effect.all(
            Array.from({ length: 3 }, () =>
              spawnWorker(worker(spec, 30_000), ws),
            ),
            { concurrency: 'unbounded' },
          )
          const details = () => workers.map(({ output }) => output()).join('\n')
          const runs = yield* Effect.all(
            inputs.map((input) => Client.start(Order, input)),
            { concurrency: 'unbounded' },
          )

          for (const [index, run] of runs.entries()) {
            const records = yield* reached(run.id, 'completed', {
              timeoutMs: 60_000,
              details,
            })
            yield* completedOnce(records, inputs[index]!)
          }
          expect(yield* ran(ws)).toEqual(inputs.flatMap(orderSteps).toSorted())
          // It was a race: no one process did all of it.
          const pids = new Set((yield* ws.events).map(({ pid }) => pid))
          expect(pids.size).toBeGreaterThan(1)
        }),
      { timeout: 120_000 },
    )
  })
}
