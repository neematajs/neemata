import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import type { Plan, ReadScope, WorkflowProgram } from '../../src/index.ts'
import { begin, coordinate, settle, start, Store } from '../../src/index.ts'
import {
  claimAttempts,
  completed,
  LEASE,
  load,
  setup,
  unused,
} from '../support.ts'

const activity = (name: string) => ({
  kind: 'activity' as const,
  name,
  execute: unused,
  input: () => 1,
})

const sequential: WorkflowProgram = {
  kind: 'workflow',
  name: 'rounds.sequential',
  steps: ['a', 'b', 'c', 'd', 'e'].map(activity),
  result: ({ e }) => e,
}

const parallel: WorkflowProgram = {
  kind: 'workflow',
  name: 'rounds.parallel',
  steps: [
    {
      kind: 'parallel',
      name: 'fan',
      members: Object.fromEntries(
        ['a', 'b', 'c'].map((key) => [key, activity(key)]),
      ),
    },
  ],
  result: ({ fan }) => fan,
}

describe('a run of activities is planned once per commit', () => {
  for (const program of [sequential, parallel]) {
    it.effect(`${program.name}, from its start to its end`, () => {
      const { served, store } = setup([program])
      // What each transaction planned, by the operation it was of: a plan
      // that asks for more is planned again, and seen twice.
      const plans: string[] = []
      let operation = ''
      const recording = Store.of({
        ...store,
        transact: <A, E = never>(scope: ReadScope, plan: Plan<A, E>) =>
          store.transact(scope, (snapshot) => {
            const planned = plan(snapshot)
            plans.push(`${operation}: ${planned._tag}`)
            return planned
          }),
      })
      const as = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          operation = name
          return effect
        })

      return Effect.provideService(
        Effect.gen(function* () {
          const { run } = yield* as(
            'start',
            start({ name: program.name, input: 1 }),
          )
          for (;;) {
            const passes = yield* store.claim({
              lanes: [{ kind: 'continueRun', routes: served.workflows }],
              limit: 10,
              leaseMs: LEASE,
            })
            for (const claim of passes) {
              yield* as('pass', coordinate(served, claim))
            }
            const attempts = yield* claimAttempts(served)
            for (const claim of attempts) {
              yield* as('begin', begin(served, claim))
            }
            for (const claim of attempts) {
              yield* as('settle', settle(served, claim, completed(1)))
            }
            if (passes.length === 0 && attempts.length === 0) break
          }

          expect((yield* load(run.id)).run.status).toBe('completed')
          expect(plans.filter((plan) => !plan.endsWith(': Commit'))).toEqual([])
          // Every step came to a pass, an attempt begun and one settled.
          const members = program === sequential ? 5 : 3
          for (const kind of ['begin', 'settle']) {
            expect(plans.filter((plan) => plan.startsWith(kind))).toHaveLength(
              members,
            )
          }
        }),
        Store,
        recording,
      )
    })
  }
})
