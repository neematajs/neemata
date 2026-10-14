import {
  Client,
  describeDefinition,
  isTerminal,
  Worker,
} from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { describe, expect } from 'vitest'

import type { StoreSpec } from './fixtures/store.ts'
import type { WorkerConfig } from './fixtures/worker.ts'
import { generation, Host, revisionOutput } from './fixtures/app.ts'
import {
  reached,
  requireServices,
  scenario,
  serve,
  settled,
  spawnWorker,
  targets,
  until,
  workspace,
} from './support.ts'

/**
 * Revisions served by separate workers, deployments that stop serving one
 * and serve it again, and code that drifted under a revision.
 */

requireServices()

const v1 = generation('v1', 'io')
const v2 = generation('v2', 'heavy')
const fast = { pollMs: 25, concurrency: 4 } as const

/** Every run of the family pinned to `revision`, and completed. */
const pinned = Effect.fnUntraced(function* (runId: string, revision: string) {
  const family = yield* Client.getFamily(runId)
  expect(family).toHaveLength(3)
  for (const { run } of family) {
    expect(run).toMatchObject({ revision, status: 'completed' })
  }
})

/** A deployment as a process: both roles, for the revisions it names. */
const deployment = (
  spec: StoreSpec,
  served: readonly string[],
  leaseMs = 2_000,
): WorkerConfig => ({
  store: spec,
  served,
  coordinator: { ...fast, leaseMs, reaping: { everyMs: 250 } },
  execution: served.map((name) => ({
    ...fast,
    leaseMs,
    pool: name === 'v1' ? 'io' : 'heavy',
  })),
})

for (const target of targets) {
  describe.skipIf(!target.url)(`revisions on ${target.name}`, () => {
    scenario(
      target,
      'runs each revision with its own code, on the workers and pools that serve it',
      () =>
        Effect.gen(function* () {
          const seen: { step: string; revision: string; pool: string }[] = []
          const host = (pool: string) =>
            Effect.provideService(Host, {
              pool,
              saw: (step) => seen.push({ ...step, pool }),
            })
          // Each revision has workers of its own; none serves the other.
          yield* serve(
            Worker.coordinator({ workflows: v1.workflows, ...fast }),
            Worker.coordinator({ workflows: v2.workflows, ...fast }),
            host('io')(Worker.execution({ ...v1, pool: 'io', ...fast })),
            host('heavy')(Worker.execution({ ...v2, pool: 'heavy', ...fast })),
          )
          const runs = yield* Effect.all(
            Array.from({ length: 6 }, (_, index) =>
              Client.start(
                index % 2 === 0 ? v1.Parent : v2.Parent,
                `x${index}`,
              ),
            ),
            { concurrency: 'unbounded' },
          )

          for (const [index, run] of runs.entries()) {
            const revision = index % 2 === 0 ? 'v1' : 'v2'
            const { run: done } = yield* reached(run.id, 'completed')
            expect(done.output).toEqual(revisionOutput(`x${index}`, revision))
            expect(done.graphHash).toBe(
              describeDefinition(index % 2 === 0 ? v1.Parent : v2.Parent)
                .graphHash,
            )
            yield* pinned(run.id, revision)
          }
          expect(seen).toHaveLength(runs.length * 3)
          for (const { revision, pool } of seen) {
            expect(pool).toBe(revision === 'v1' ? 'io' : 'heavy')
          }
        }),
    )

    scenario(
      target,
      'parks the work of a revision that stops being served, counting nothing against it, and resumes it when served again',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const leaseMs = 2_000
          const both = yield* spawnWorker(deployment(spec, ['v1', 'v2']), ws)
          const crashed = yield* Client.start(v1.Parent, 'hang-1')
          yield* until('the v1 activity to be held', ws.held('hang-1.v1'), {
            details: both.output,
          })
          // The deployment dies under the activity.
          both.signal('SIGKILL')
          yield* both.exited

          // The next serves v2 only: v1 work waits, whatever is due of it.
          const only = yield* spawnWorker(deployment(spec, ['v2']), ws)
          const parked = yield* Client.start(v1.Parent, 'x')
          const current = yield* Client.start(v2.Parent, 'y')
          yield* reached(current.id, 'completed', { details: only.output })
          // Long past the crashed lease, and past what deliveries the store
          // allows a command, had any counted.
          yield* Effect.sleep(leaseMs * 3)
          expect((yield* Client.get(parked.id))!.run.status).toBe('queued')
          const held = (yield* Client.get(crashed.id))!
          expect(held.run.status).toBe('running')
          expect(held.attempts).toMatchObject([
            { nodeName: 'first', status: 'started', attemptNumber: 1 },
          ])
          expect(yield* Client.listDeadCommands()).toEqual({ commands: [] })
          only.signal('SIGTERM')
          yield* only.exited

          // Served again, both resume on v1 code, the crashed attempt as
          // the attempt it was.
          const again = yield* spawnWorker(deployment(spec, ['v1', 'v2']), ws)
          for (const [run, input] of [
            [crashed, 'hang-1'],
            [parked, 'x'],
          ] as const) {
            const { run: done } = yield* reached(run.id, 'completed', {
              details: again.output,
            })
            expect(done.output).toEqual(revisionOutput(input, 'v1'))
            yield* pinned(run.id, 'v1')
          }
          expect((yield* Client.get(crashed.id))!.attempts).toMatchObject([
            { nodeName: 'first', status: 'completed', attemptNumber: 1 },
          ])
          const family = [crashed, parked, current].map(({ id }) => id)
          expect(yield* settled(family)).toEqual({ dead: [], claimed: [] })

          // Every step ran on the pool of its revision.
          const stamped = (yield* ws.events).filter(
            ({ event }) => event === 'stamped',
          )
          expect(stamped).toHaveLength(9)
          for (const { revision, servedBy } of stamped) {
            expect(servedBy).toBe(revision === 'v1' ? 'io' : 'heavy')
          }
        }),
      { maxDeliveries: 2, timeout: 90_000 },
    )

    scenario(
      target,
      'never runs a run with code that drifted under its revision, and fails it once its command is set aside',
      () =>
        Effect.gen(function* () {
          const drifted = generation('v1', 'io', { reshaped: true })
          // Started where the original v1 is deployed, and nothing runs it.
          const run = yield* Client.start(v1.Parent, 'x')
          expect(
            yield* Effect.flip(Client.start(drifted.Parent, 'y')),
          ).toMatchObject({ _tag: 'DefinitionConflict' })

          const seen: string[] = []
          yield* serve(
            Worker.coordinator({
              workflows: drifted.workflows,
              ...fast,
              reaping: { everyMs: 250 },
            }),
            Worker.execution({ ...drifted, ...fast }).pipe(
              Effect.provideService(Host, {
                pool: 'io',
                saw: ({ step }) => seen.push(step),
              }),
            ),
          )

          // Given back with the conflict at each delivery, later each time,
          // until the store sets it aside and the reaper ends the run.
          const failed = yield* reached(run.id, 'failed', { timeoutMs: 45_000 })
          expect(failed.run.error).toMatchObject({ name: 'DefinitionConflict' })
          expect(failed.nodes).toEqual([])
          expect(seen).toEqual([])
          const { commands } = yield* Client.listDeadCommands({ runId: run.id })
          expect(commands).toMatchObject([
            {
              command: { kind: 'continueRun', runId: run.id, revision: 'v1' },
              deliveries: 2,
              error: { name: 'DefinitionConflict' },
            },
          ])
          expect((yield* Client.list()).runs).toHaveLength(1)
        }),
      { maxDeliveries: 2 },
    )

    scenario(
      target,
      'cancels a task of an unserved revision at once, and a workflow once its revision is served again',
      () =>
        Effect.gen(function* () {
          // Only v2 is served.
          yield* serve(
            Worker.coordinator({ workflows: v2.workflows, ...fast }),
            Worker.execution({ ...v2, ...fast }).pipe(
              Effect.provideService(Host, { pool: 'heavy' }),
            ),
          )
          const task = yield* Client.start(v1.Work, 'x')
          const flow = yield* Client.start(v1.Parent, 'y')

          expect((yield* Client.cancel(task.id))?.status).toBe('cancelled')
          expect((yield* Client.cancel(flow.id))?.status).toBe('cancelling')
          yield* Effect.sleep('1 second')
          expect((yield* Client.get(flow.id))!.run.status).toBe('cancelling')

          yield* serve(Worker.coordinator({ workflows: v1.workflows, ...fast }))
          const { run } = yield* reached(flow.id, 'cancelled')
          expect(run.revision).toBe('v1')
          expect(yield* settled([task.id, flow.id])).toEqual({
            dead: [],
            claimed: [],
          })
        }),
    )

    scenario(
      target,
      'retries and restarts a run on its own revision while another is deployed beside it',
      () =>
        Effect.gen(function* () {
          let broken = true
          const seen: string[] = []
          const host = (pool: string) =>
            Effect.provideService(Host, {
              pool,
              saw: ({ step, revision }) => {
                seen.push(`${step}@${revision}`)
                if (broken && step === 'task') throw new Error('broken')
              },
            })
          yield* serve(
            Worker.coordinator({
              workflows: [...v1.workflows, ...v2.workflows],
              ...fast,
            }),
            host('io')(Worker.execution({ ...v1, pool: 'io', ...fast })),
            host('heavy')(Worker.execution({ ...v2, pool: 'heavy', ...fast })),
          )
          const run = yield* Client.start(v1.Parent, 'x')
          yield* reached(run.id, 'failed')

          broken = false
          yield* Client.retry(run.id)
          const { run: retried } = yield* reached(run.id, 'completed')
          expect(retried.output).toEqual(revisionOutput('x', 'v1'))
          yield* pinned(run.id, 'v1')

          // Given both revisions, a restart takes the one the run was of.
          const restarted = yield* Client.restart(run.id, {
            definitions: [v2.Parent, v1.Parent],
          })
          expect(restarted).toMatchObject({ revision: 'v1', input: 'x' })
          const { run: again } = yield* reached(restarted.id, 'completed')
          expect(again.output).toEqual(revisionOutput('x', 'v1'))
          expect(seen.every((step) => step.endsWith('@v1'))).toBe(true)
        }),
    )

    scenario(
      target,
      'lets every concurrent start of a new revision win, and one of two graphs racing for it',
      () =>
        Effect.gen(function* () {
          const starts = yield* Effect.all(
            Array.from({ length: 10 }, (_, index) =>
              Client.start(v1.Parent, `x${index}`),
            ),
            { concurrency: 'unbounded' },
          )
          expect(new Set(starts.map(({ id }) => id)).size).toBe(10)
          for (const run of starts) expect(run.revision).toBe('v1')

          for (let round = 0; round < 10; round++) {
            const revision = `race-${round}`
            const candidates = [
              generation(revision, 'io').Parent,
              generation(revision, 'io', { reshaped: true }).Parent,
            ]
            const results = yield* Effect.all(
              candidates.map((candidate) =>
                Effect.exit(Client.start(candidate, 'x')),
              ),
              { concurrency: 'unbounded' },
            )
            const won = results.flatMap((exit, index) =>
              Exit.isSuccess(exit) ? [{ run: exit.value, index }] : [],
            )
            expect(won).toHaveLength(1)
            for (const exit of results.filter(Exit.isFailure)) {
              expect(yield* Effect.flip(exit)).toMatchObject({
                _tag: 'DefinitionConflict',
              })
            }
            const [{ run, index }] = won as [(typeof won)[number]]
            const saved = yield* Client.getDefinition({
              kind: 'workflow',
              name: 'it.rev.parent',
              revision,
            })
            const { graphHash } = describeDefinition(candidates[index]!)
            expect(run.graphHash).toBe(graphHash)
            expect(saved?.graph.graphHash).toBe(graphHash)
            expect(
              (yield* Client.list({ revision })).runs.map(({ id }) => id),
            ).toEqual([run.id])
          }
        }),
    )

    scenario(
      target,
      'gives a key to one revision when starts of two race for it',
      () =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            Array.from({ length: 10 }, (_, index) =>
              Effect.exit(
                Client.start(index % 2 === 0 ? v1.Parent : v2.Parent, 'x', {
                  idempotencyKey: ['order', 1],
                }),
              ),
            ),
            { concurrency: 'unbounded' },
          )
          const runs = results.flatMap((exit) =>
            Exit.isSuccess(exit) ? [exit.value] : [],
          )
          const [owner] = runs
          // Whichever revision came first owns the key; its own starts are
          // answered with the run, the other's are refused and told of it.
          expect(new Set(runs.map(({ id }) => id))).toEqual(
            new Set([owner!.id]),
          )
          expect(runs).toHaveLength(5)
          for (const exit of results.filter(Exit.isFailure)) {
            expect(yield* Effect.flip(exit)).toMatchObject({
              _tag: 'IdempotencyConflict',
              runId: owner!.id,
            })
          }
          const listed = (yield* Client.list()).runs
          expect(listed.map(({ id }) => id)).toEqual([owner!.id])
          expect(isTerminal(listed[0]!.status)).toBe(false)
        }),
    )
  })
}
