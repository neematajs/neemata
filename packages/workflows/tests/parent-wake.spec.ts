import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import type {
  Plan,
  Planned,
  ReadScope,
  TaskProgram,
  WorkflowProgram,
} from '../src/index.ts'
import { Client, coordinate, settle, start, Store } from '../src/index.ts'
import { continueRun } from '../src/model.ts'
import { unitOf } from '../src/plan/attempt.ts'
import { unitKey } from '../src/store.ts'
import {
  claimAttempts,
  completed,
  failed,
  LEASE,
  load,
  pass,
  setup,
  unused,
  work,
} from './support.ts'

const charge: TaskProgram = {
  kind: 'task',
  name: 'charge',
  revision: 't1',
  execute: unused,
}

/** A pinned parent whose items are task runs of another revision. */
const batch: WorkflowProgram = {
  kind: 'workflow',
  name: 'batch',
  revision: 'r1',
  steps: [
    {
      kind: 'map',
      name: 'each',
      items: (_outputs, input) => input as readonly unknown[],
      input: (_outputs, _input, item) => item,
      target: { kind: 'task', task: { name: 'charge', revision: 't1' } },
    },
  ],
  result: ({ each }) => each,
}

/** A pinned parent of a child workflow of one activity. */
const child: WorkflowProgram = {
  kind: 'workflow',
  name: 'child',
  steps: [{ kind: 'activity', name: 'work', execute: unused, input: () => 1 }],
  result: ({ work }) => work,
}
const parent: WorkflowProgram = {
  kind: 'workflow',
  name: 'parent',
  revision: 'r1',
  steps: [
    {
      kind: 'workflow',
      name: 'call',
      workflow: { name: 'child' },
      input: (_outputs, input) => input,
    },
  ],
  result: ({ call }) => call,
}

/**
 * Every plan the store runs: what it was given loaded, and its answer. A plan
 * that answers `Need` is run again with more loaded, and is seen twice.
 */
function recorded(store: ReturnType<typeof Store.of>) {
  const plans: {
    readonly runs: readonly string[]
    readonly heads: readonly string[]
    readonly units: readonly string[]
    readonly open: readonly string[]
    readonly planned: Planned<unknown, unknown>
  }[] = []
  const recording = Store.of({
    ...store,
    transact: <A, E = never>(scope: ReadScope, plan: Plan<A, E>) =>
      store.transact(scope, (snapshot) => {
        const planned = plan(snapshot)
        plans.push({
          runs: Array.from(snapshot.runs.keys()),
          heads: Array.from(snapshot.heads.keys()),
          units: Array.from(snapshot.units.keys()),
          open: Array.from(snapshot.open.keys()),
          planned,
        })
        return planned
      }),
  })
  const through = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    plans.length = 0
    return Effect.provideService(effect, Store, recording)
  }
  return { plans, through }
}

/** The one plan run, which committed: what it wrote and queued. */
function committed(plans: ReturnType<typeof recorded>['plans']) {
  expect(plans).toHaveLength(1)
  const [{ planned, ...loaded }] = plans as [(typeof plans)[number]]
  expect(planned._tag).toBe('Commit')
  const { mutation } = planned as Extract<typeof planned, { _tag: 'Commit' }>
  return {
    loaded,
    written: (mutation.runs ?? []).map(({ id }) => id),
    queued: (mutation.enqueue ?? []).map(({ command }) => command),
  }
}

describe('a run that ends wakes its parent', () => {
  it.effect('from its own record, in one plan of the run alone', () => {
    const { served, provide, store } = setup([batch, charge])
    const { plans, through } = recorded(store)

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({
          name: 'batch',
          revision: 'r1',
          input: ['a', 'b'],
        })
        yield* pass(served)
        const [claim] = yield* claimAttempts(served)
        const taskRunId = claim!.command.runId
        // Created with the route of the parent's own passes.
        expect((yield* load(taskRunId)).run).toMatchObject({
          parentRunId: run.id,
          parentRoute: { name: 'batch', revision: 'r1' },
        })

        yield* through(settle(served, claim!, completed(1)))
        // The parent is neither loaded nor written: the run alone is, and
        // of what it owns the attempt's unit.
        expect(committed(plans)).toStrictEqual({
          loaded: {
            runs: [],
            heads: [],
            units: [unitKey(unitOf(claim!.command))],
            open: [],
          },
          written: [taskRunId],
          queued: [continueRun({ id: run.id, name: 'batch', revision: 'r1' })],
        })

        // The wake is claimed by the parent's lane and advances it.
        expect(yield* pass(served)).toBe(1)
        expect(
          (yield* load(run.id)).children.map(({ status }) => status),
        ).toStrictEqual(['completed', 'waiting'])
      }),
    )
  })

  it.effect('again on every pass of it after it ended, in one plan', () => {
    const { served, provide, store } = setup([parent, child])
    const { plans, through } = recorded(store)
    // A pass of the child alone: the parent's lane is left to `pass`.
    const childPass = Effect.gen(function* () {
      const [claim] = yield* store.claim({
        lanes: [{ kind: 'continueRun', routes: [{ name: 'child' }] }],
        limit: 1,
        leaseMs: LEASE,
      })
      return yield* through(coordinate(served, claim!))
    })

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({
          name: 'parent',
          revision: 'r1',
          input: 1,
        })
        yield* pass(served)
        const childRunId = (yield* load(run.id)).children[0]!.childRunId!
        yield* pass(served)
        yield* work(served, failed('no'))
        const wake = continueRun({ id: run.id, name: 'parent', revision: 'r1' })

        // The pass that ends it.
        yield* childPass
        expect(committed(plans)).toStrictEqual({
          loaded: { runs: [], heads: [], units: [], open: [childRunId] },
          written: [childRunId],
          queued: [wake],
        })
        expect((yield* load(childRunId)).run.status).toBe('failed')

        // A pass of the ended run, as a duplicate delivery makes one.
        yield* store.transact({}, () => ({
          _tag: 'Commit',
          mutation: {
            enqueue: [
              {
                command: continueRun({ id: childRunId, name: 'child' }),
                dedupe: `continue:${childRunId}`,
              },
            ],
          },
          result: undefined,
        }))
        yield* childPass
        expect(committed(plans)).toStrictEqual({
          loaded: { runs: [], heads: [], units: [], open: [childRunId] },
          written: [],
          queued: [wake],
        })

        // Both wakes wait as one, which the parent claims and is failed by.
        expect(yield* pass(served)).toBe(1)
        expect((yield* load(run.id)).run.status).toBe('failed')
      }),
    )
  })

  it.effect('by the route it keeps when a retry reopens it', () => {
    const { served, provide } = setup([parent, child])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({
          name: 'parent',
          revision: 'r1',
          input: 1,
        })
        yield* pass(served)
        const childRunId = (yield* load(run.id)).children[0]!.childRunId!
        yield* pass(served)
        yield* work(served, failed('no'))
        yield* pass(served)
        yield* pass(served)
        expect((yield* load(run.id)).run.status).toBe('failed')

        yield* Client.retry(run.id)
        // The parent's pass reopens the child, which keeps its route.
        yield* pass(served)
        expect((yield* load(childRunId)).run).toMatchObject({
          status: 'queued',
          parentRoute: { name: 'parent', revision: 'r1' },
        })
        yield* pass(served)
        yield* work(served, completed(2))
        // The child ends, and only its wake brings the parent to its end.
        yield* pass(served)
        expect((yield* load(run.id)).run.status).toBe('waiting')
        expect(yield* pass(served)).toBe(1)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 2,
        })
      }),
    )
  })
})
