import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import type { Mutation, ReadScope, StoredChild } from '../../src/index.ts'
import { requeue, start, Store } from '../../src/index.ts'
import { pass, setup } from '../support.ts'

/** What the reference store adds to the contract every store keeps. */
describe('the in-memory store', () => {
  const programs = [
    { kind: 'workflow', name: 'order', steps: [], result: () => 'done' },
  ] as const

  const write = (scope: ReadScope, mutation: Mutation) =>
    Effect.flatMap(Store, (store) =>
      Effect.exit(
        store.transact(scope, () => ({
          _tag: 'Commit',
          mutation,
          result: undefined,
        })),
      ),
    )

  const child = (
    runId: string,
    status: StoredChild['status'],
  ): StoredChild => ({
    runId,
    nodeName: 'price',
    childKey: '$self',
    kind: 'activity',
    status,
    attemptCount: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  })

  it.effect(
    'refuses what a run owns from a plan that did not load the run',
    () => {
      const { provide, inspect } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'order', input: 1 })
          yield* write(
            { runs: [run.id] },
            {
              nodes: [
                {
                  runId: run.id,
                  name: 'price',
                  kind: 'activity',
                  status: 'running',
                  version: 1,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
              children: [child(run.id, 'running')],
            },
          )

          // It saw neither the run nor the child it would write over.
          const blind = yield* write(
            {},
            { children: [child(run.id, 'failed')] },
          )
          expect(String(blind)).toContain(`Unguarded write to [run:${run.id}]`)
          expect(inspect.runs()[0]!.children).toMatchObject([
            { status: 'running' },
          ])
        }),
      )
    },
  )

  it.effect(
    'plans again when a dead command it loaded came or went before the commit',
    () => {
      let gap: Effect.Effect<unknown, unknown, Store> | undefined
      // Set aside at their first claim.
      const { provide, inspect, store, served } = setup(programs, {
        maxDeliveries: 0,
        beforeCommit: () => {
          const act = gap
          gap = undefined
          if (act) Effect.runSync(Effect.provideService(act, Store, store))
        },
      })
      /** What a plan that loads the command sees of it, each time it runs. */
      const seen = (id: string) => {
        const dead: boolean[] = []
        return Effect.as(
          store.transact({ dead: [id] }, (snapshot) => {
            dead.push(snapshot.dead.get(id) !== undefined)
            return { _tag: 'Commit', mutation: {}, result: undefined }
          }),
          dead,
        )
      }

      return provide(
        Effect.gen(function* () {
          yield* start({ name: 'order', input: 1 })
          const { id } = inspect.queue()[0]!

          gap = pass(served)
          expect(yield* seen(id)).toStrictEqual([false, true])

          const [command] = (yield* store.dead({ id, limit: 1 })).items
          gap = requeue(command!.id)
          expect(yield* seen(id)).toStrictEqual([true, false])
        }),
      )
    },
  )

  it.effect('applies nothing of a mutation it refuses a later part of', () => {
    const { provide, inspect } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'order', input: 1 })
        const before = inspect.runs()
        const next = { ...run, status: 'running', version: 2 } as const

        // A run it may write, then a child of a run that is not there.
        const orphan = yield* write(
          { runs: [run.id, 'run-missing'] },
          { runs: [next], children: [child('run-missing', 'running')] },
        )
        expect(String(orphan)).toContain('Run [run-missing] does not exist')
        expect(inspect.runs()).toStrictEqual(before)

        // A family it removes, and a run of that family written as well.
        const both = yield* write(
          { families: [run.id], runs: [run.id] },
          { remove: [run.id], runs: [next] },
        )
        expect(String(both)).toContain('of a removed family')
        expect(inspect.runs()).toStrictEqual(before)
      }),
    )
  })
})
