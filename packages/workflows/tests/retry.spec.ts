import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as TestClock from 'effect/testing/TestClock'

import type {
  Execute,
  Mutation,
  Program,
  Registry,
  RetryPolicy,
  TaskProgram,
  WorkflowProgram,
} from '../src/index.ts'
import {
  begin,
  cancel,
  Client,
  RunBusy,
  RunConflict,
  RunNotFailed,
  RunNotFound,
  RunNotRoot,
  settle,
  StaleRunVersion,
  start,
  Store,
  Worker,
} from '../src/index.ts'
import * as support from './support.ts'
import { claimAttempts, failed, LEASE, load, pass, work } from './support.ts'

/** What handlers do is switched by tests; what they were given is kept. */
function world() {
  const state = { failing: new Set<string>(), calls: [] as string[] }
  const handler =
    (name: string): Execute =>
    (input) =>
      Effect.suspend(() => {
        const call = `${name}:${JSON.stringify(input)}`
        state.calls.push(call)
        return state.failing.has(name) || state.failing.has(call)
          ? Effect.fail(new Error(`${call} failed`))
          : Effect.succeed(`${call} ok`)
      })
  return { state, handler }
}

/** Runs the handler of every due attempt once and settles what it came to. */
const execute = Effect.fnUntraced(function* (served: Registry) {
  const claims = yield* claimAttempts(served)
  for (const claim of claims) {
    const begun = yield* begin(served, claim)
    if (begun._tag !== 'Begun') continue
    const exit = yield* Effect.exit(
      begun.executable.execute(claim.command.input, begun.attempt),
    )
    yield* settle(
      served,
      claim,
      Exit.isSuccess(exit)
        ? { _tag: 'Completed', output: exit.value }
        : {
            _tag: 'Failed',
            error: { message: (Cause.squash(exit.cause) as Error).message },
          },
    )
  }
  return claims.length
})

/** Passes and attempts until nothing is due at this time. */
const drain = Effect.fnUntraced(function* (served: Registry) {
  for (let round = 0; round < 100; round++) {
    const passed = yield* pass(served)
    const ran = yield* execute(served)
    if (passed === 0 && ran === 0) return
  }
  return yield* Effect.die('Did not settle')
})

const setup = (
  programs: readonly Program[],
  options?: Parameters<typeof support.setup>[1],
) => support.setup(programs, options)

const activity = (name: string, execute: Execute, retry?: RetryPolicy) =>
  ({
    kind: 'activity',
    name,
    execute,
    input: (_outputs: unknown, input: unknown) => input,
    ...(retry === undefined ? {} : { retry }),
  }) as const

describe('a manual retry', () => {
  it.effect(
    'reopens the run in place and runs only the work that failed',
    () => {
      const { state, handler } = world()
      let computed = 0
      const flow: WorkflowProgram = {
        kind: 'workflow',
        name: 'flow',
        revision: 'v1',
        steps: [
          activity('first', handler('first')),
          {
            kind: 'parallel',
            name: 'members',
            members: {
              good: { ...activity('good', handler('good')), input: () => 'g' },
              bad: {
                ...activity('bad', handler('bad')),
                input: () => {
                  computed += 1
                  return { value: 42 }
                },
              },
            },
          },
        ],
        result: ({ first, members }) => ({ first, members }),
      }
      const { served, provide } = setup([flow])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({
            name: 'flow',
            revision: 'v1',
            input: { value: 1 },
            tags: { source: 'test' },
            idempotencyKey: ['root-key'],
          })
          state.failing.add('bad')
          yield* drain(served)
          const before = yield* load(run.id)
          expect(before.run).toMatchObject({
            status: 'failed',
            error: { message: 'bad:{"value":42} failed' },
          })

          yield* TestClock.adjust(60_000)
          state.failing.clear()
          const reopened = yield* Client.retry(run.id, {
            expectedVersion: before.run.version,
          })
          // The same run: nothing that says what it is has changed.
          const { error: _error, ...kept } = before.run
          expect(reopened).toStrictEqual({
            ...kept,
            status: 'queued',
            version: before.run.version + 1,
            activeSince: 60_000,
            updatedAt: 60_000,
          })
          expect(reopened).toMatchObject({
            id: run.id,
            revision: 'v1',
            input: { value: 1 },
            tags: { source: 'test' },
            idempotencyKey: ['root-key'],
            createdAt: 0,
          })
          // A request made on the view from before the retry is stale.
          expect(
            yield* Effect.flip(
              Client.retry(run.id, { expectedVersion: before.run.version }),
            ),
          ).toStrictEqual(new RunNotFailed({ runId: run.id, status: 'queued' }))

          yield* drain(served)
          const after = yield* load(run.id)
          expect(after.run).toMatchObject({
            status: 'completed',
            output: {
              first: 'first:{"value":1} ok',
              members: { good: 'good:"g" ok', bad: 'bad:{"value":42} ok' },
            },
          })
          expect(after.run.error).toBeUndefined()
          // Each completed handler ran once; the failed one ran again, on
          // the input its first attempt was given, which was not computed
          // a second time.
          expect(state.calls).toStrictEqual([
            'first:{"value":1}',
            'good:"g"',
            'bad:{"value":42}',
            'bad:{"value":42}',
          ])
          expect(computed).toBe(1)

          // History is kept as it was, and the new attempt continues it.
          for (const attempt of before.attempts) {
            expect(after.attempts).toContainEqual(attempt)
          }
          expect(after.attempts).toHaveLength(4)
          expect(
            after.attempts.filter(({ childKey }) => childKey === 'member:bad'),
          ).toMatchObject([
            { attemptNumber: 1, retryAttemptNumber: 1, status: 'failed' },
            {
              attemptNumber: 2,
              retryAttemptNumber: 1,
              status: 'completed',
              input: { value: 42 },
              dispatchedAt: 60_000,
            },
          ])
          expect(after.children).toContainEqual(
            expect.objectContaining({
              childKey: 'member:bad',
              attemptCount: 2,
            }),
          )
          for (const record of [...after.nodes, ...after.children]) {
            expect(record.error).toBeUndefined()
          }
        }),
      )
    },
  )

  it.effect('reopens the root alone, and each run under it in its turn', () => {
    const { state, handler } = world()
    const child: WorkflowProgram = {
      kind: 'workflow',
      name: 'child',
      steps: [activity('work', handler('work'))],
      result: ({ work }) => work,
    }
    const parent: WorkflowProgram = {
      kind: 'workflow',
      name: 'parent',
      steps: [
        {
          kind: 'map',
          name: 'each',
          items: (_outputs, input) => input as number[],
          input: (_outputs, _input, item) => item,
          target: { kind: 'workflow', workflow: { name: 'child' } },
        },
      ],
      result: ({ each }) => each,
    }
    const written: Mutation[] = []
    const { served, provide } = setup([parent, child], {
      beforeCommit: (mutation) => void written.push(mutation),
    })

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'parent', input: [1, 2, 3] })
        state.failing.add('work:2').add('work:3')
        yield* drain(served)
        const before = yield* load(run.id)
        expect(before.run.status).toBe('failed')
        const childIds = before.children.map(({ childRunId }) => childRunId!)

        state.failing.clear()
        written.length = 0
        yield* Client.retry(run.id)
        // One commit, of one run: a family is never reopened in one go.
        expect(
          written.filter(({ runs = [] }) => runs.length > 0),
        ).toMatchObject([{ runs: [{ id: run.id, status: 'queued' }] }])
        expect((yield* load(childIds[1]!)).run.status).toBe('failed')

        yield* drain(served)
        const after = yield* load(run.id)
        // The same child runs, the completed one untouched.
        expect(
          after.children.map(({ childRunId }) => childRunId),
        ).toStrictEqual(childIds)
        expect(after.run).toMatchObject({
          status: 'completed',
          output: {
            items: [1, 2, 3].map((item, index) => ({
              item,
              index,
              runId: childIds[index],
              output: `work:${item} ok`,
            })),
          },
        })
        expect(state.calls).toStrictEqual([
          'work:1',
          'work:2',
          'work:3',
          'work:2',
          'work:3',
        ])
        const reopened = yield* load(childIds[1]!)
        expect(reopened.run).toMatchObject({
          status: 'completed',
          parentRunId: run.id,
        })
        expect(reopened.attempts).toMatchObject([
          { attemptNumber: 1, status: 'failed' },
          { attemptNumber: 2, retryAttemptNumber: 1, status: 'completed' },
        ])
      }),
    )
  })

  it.effect(
    'reruns the failed items of a map within its limit, without asking for the items again',
    () => {
      const { state, handler } = world()
      let listed = 0
      const job: TaskProgram = {
        kind: 'task',
        name: 'job',
        execute: handler('job'),
      }
      const flow: WorkflowProgram = {
        kind: 'workflow',
        name: 'flow',
        steps: [
          {
            kind: 'map',
            name: 'items',
            items: (_outputs, input) => {
              listed += 1
              return input as number[]
            },
            input: (_outputs, _input, item) => item,
            target: { kind: 'task', task: { name: 'job' } },
            concurrency: 1,
          },
        ],
        result: ({ items }) => items,
      }
      const { served, provide, inspect } = setup([flow, job])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'flow', input: [0, 1, 2, 3] })
          state.failing.add('job:0').add('job:2').add('job:3')
          yield* drain(served)
          const before = yield* load(run.id)
          expect(before.run.status).toBe('failed')
          const childIds = before.children.map(({ childRunId }) => childRunId)

          state.failing.clear()
          yield* Client.retry(run.id)
          // One at a time, as before: a pass reopens no more than may run.
          for (const calls of [5, 6, 7]) {
            yield* pass(served)
            expect(
              inspect
                .queue()
                .filter(({ command }) => command.kind === 'runTask'),
            ).toHaveLength(1)
            yield* execute(served)
            expect(state.calls).toHaveLength(calls)
          }
          yield* pass(served)

          const after = yield* load(run.id)
          expect(listed).toBe(1)
          expect(state.calls).toStrictEqual([
            'job:0',
            'job:1',
            'job:2',
            'job:3',
            'job:0',
            'job:2',
            'job:3',
          ])
          expect(
            after.children.map(({ childRunId }) => childRunId),
          ).toStrictEqual(childIds)
          expect(after.run).toMatchObject({
            status: 'completed',
            output: {
              items: childIds.map((runId, index) => ({
                item: index,
                index,
                runId,
                output: `job:${index} ok`,
              })),
            },
          })
        }),
      )
    },
  )

  it.effect.each([
    ['a task run', 'task'] as const,
    ['an activity', 'activity'] as const,
  ])(
    'gives %s a new budget of retries and its first backoff, every time',
    ([, kind]) => {
      const { state, handler } = world()
      const retry: RetryPolicy = {
        attempts: 3,
        backoff: 'exponential',
        delay: '1s',
      }
      const programs: Program[] =
        kind === 'task'
          ? [{ kind: 'task', name: 'work', execute: handler('work'), retry }]
          : [
              {
                kind: 'workflow',
                name: 'work',
                steps: [activity('act', handler('work'), retry)],
                result: ({ act }) => act,
              },
            ]
      const { served, provide, inspect } = setup(programs)

      /** The delays between the attempts of one budget, until it is spent. */
      const exhaust = Effect.fnUntraced(function* () {
        const delays: number[] = []
        for (;;) {
          yield* drain(served)
          const [waiting] = inspect.queue()
          if (!waiting) return delays
          const now = yield* Clock.currentTimeMillis
          delays.push(waiting.availableAt - now)
          yield* TestClock.adjust(waiting.availableAt - now)
        }
      })

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({
            kind: kind === 'task' ? 'task' : 'workflow',
            name: 'work',
            input: 1,
          })
          state.failing.add('work')

          expect(yield* exhaust()).toStrictEqual([1_000, 2_000])
          expect((yield* load(run.id)).run.status).toBe('failed')
          for (const round of [1, 2]) {
            yield* Client.retry(run.id)
            // Not the four seconds a fourth attempt in a row would wait.
            expect(yield* exhaust()).toStrictEqual([1_000, 2_000])
            const { run: failed, attempts } = yield* load(run.id)
            expect(failed.status).toBe('failed')
            expect(
              attempts.map(({ attemptNumber, retryAttemptNumber }) => [
                attemptNumber,
                retryAttemptNumber,
              ]),
            ).toStrictEqual(
              [
                [1, 1],
                [2, 2],
                [3, 3],
                [4, 1],
                [5, 2],
                [6, 3],
                [7, 1],
                [8, 2],
                [9, 3],
              ].slice(0, 3 + 3 * round),
            )
          }
          expect(state.calls).toHaveLength(9)

          state.failing.clear()
          yield* Client.retry(run.id)
          yield* drain(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: 'work:1 ok',
          })
        }),
      )
    },
  )

  it.effect(
    'computes again what failed to be computed, and repeats no handler',
    () => {
      const { state, handler } = world()
      const broken = new Set(['select', 'items', 'input', 'result'])
      const failing = (what: string) => {
        if (broken.has(what)) throw new Error(`${what} failed`)
      }
      const flow: WorkflowProgram = {
        kind: 'workflow',
        name: 'flow',
        steps: [
          activity('first', handler('first')),
          {
            kind: 'branch',
            name: 'route',
            select: () => {
              failing('select')
              return 'only'
            },
            cases: { only: { ...activity('only', handler('only')) } },
          },
          {
            kind: 'map',
            name: 'each',
            items: () => {
              failing('items')
              return ['a', 'b']
            },
            input: (_outputs, _input, item) => {
              if (item === 'b') failing('input')
              return item
            },
            target: { kind: 'task', task: { name: 'job' } },
          },
        ],
        result: ({ each }) => {
          failing('result')
          return each
        },
      }
      const job: TaskProgram = {
        kind: 'task',
        name: 'job',
        execute: handler('job'),
      }
      const { served, provide } = setup([flow, job])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'flow', input: 1 })

          // Each retry gets one callback further.
          const expected = [
            ['select failed', ['first:1']],
            ['items failed', ['first:1', 'only:1']],
            // The item whose input is computed runs beside the one that fails.
            ['input failed', ['first:1', 'only:1', 'job:"a"']],
            ['result failed', ['first:1', 'only:1', 'job:"a"', 'job:"b"']],
          ] as const
          for (const [message, calls] of expected) {
            yield* drain(served)
            expect((yield* load(run.id)).run).toMatchObject({
              status: 'failed',
              error: { message },
            })
            expect(state.calls).toStrictEqual(calls)
            broken.delete(message.split(' ')[0]!)
            yield* Client.retry(run.id)
          }

          yield* drain(served)
          const after = yield* load(run.id)
          expect(after.run).toMatchObject({
            status: 'completed',
            output: {
              items: [{ output: 'job:"a" ok' }, { output: 'job:"b" ok' }],
            },
          })
          expect(state.calls).toHaveLength(4)
          // What a callback failed with was a state of the run, now gone.
          for (const record of [...after.nodes, ...after.children]) {
            expect(record).toMatchObject({ status: 'completed' })
            expect(record.error).toBeUndefined()
          }
        }),
      )
    },
  )

  it.effect(
    'reopens failed child workflows as themselves, and leaves completed ones alone',
    () => {
      const { state, handler } = world()
      const leaf: WorkflowProgram = {
        kind: 'workflow',
        name: 'leaf',
        steps: [activity('work', handler('leaf'))],
        result: ({ work }) => work,
      }
      const middle: WorkflowProgram = {
        kind: 'workflow',
        name: 'middle',
        steps: [
          activity('before', handler('before')),
          {
            kind: 'workflow',
            name: 'leaf',
            workflow: { name: 'leaf' },
            input: (_outputs, input) => input,
          },
        ],
        result: ({ leaf }) => leaf,
      }
      const root: WorkflowProgram = {
        kind: 'workflow',
        name: 'root',
        steps: [
          {
            kind: 'workflow',
            name: 'done',
            workflow: { name: 'leaf' },
            input: () => 'done',
          },
          {
            kind: 'workflow',
            name: 'middle',
            workflow: { name: 'middle' },
            input: () => 'deep',
          },
        ],
        result: ({ done, middle }) => [done, middle],
      }
      const { served, provide } = setup([root, middle, leaf])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'root', input: null })
          state.failing.add('leaf:"deep"')
          yield* drain(served)
          expect((yield* load(run.id)).run.status).toBe('failed')
          const family = (yield* Client.getFamily(run.id)).map(
            ({ run: { id, name, status } }) => ({ id, name, status }),
          )
          expect(
            family.map(({ name, status }) => [name, status]),
          ).toStrictEqual([
            ['root', 'failed'],
            ['leaf', 'completed'],
            ['middle', 'failed'],
            ['leaf', 'failed'],
          ])

          state.failing.clear()
          yield* Client.retry(run.id)
          yield* drain(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: ['leaf:"done" ok', 'leaf:"deep" ok'],
          })
          // The family is the same runs, all completed now.
          expect(
            (yield* Client.getFamily(run.id)).map(({ run: { id, status } }) => [
              id,
              status,
            ]),
          ).toStrictEqual(family.map(({ id }) => [id, 'completed']))
          expect(state.calls).toStrictEqual([
            'leaf:"done"',
            'before:"deep"',
            'leaf:"deep"',
            'leaf:"deep"',
          ])
        }),
      )
    },
  )

  it.effect('recovers what a timeout cancelled, child runs included', () => {
    const { state, handler } = world()
    const job: TaskProgram = {
      kind: 'task',
      name: 'job',
      execute: handler('job'),
    }
    const child: WorkflowProgram = {
      kind: 'workflow',
      name: 'child',
      steps: [activity('work', handler('child'))],
      result: ({ work }) => work,
    }
    const flow: WorkflowProgram = {
      kind: 'workflow',
      name: 'flow',
      timeout: '1m',
      steps: [
        {
          kind: 'parallel',
          name: 'fan',
          members: {
            own: { ...activity('own', handler('own')), input: () => 'o' },
            job: { kind: 'task', task: { name: 'job' }, input: () => 'j' },
            child: {
              kind: 'workflow',
              workflow: { name: 'child' },
              input: () => 'c',
            },
          },
        },
      ],
      result: ({ fan }) => fan,
    }
    const { served, provide } = setup([flow, child, job])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: null })
        // Everything is started, and nothing is run.
        yield* pass(served)
        yield* pass(served)
        yield* TestClock.adjust(60_001)
        expect(yield* Worker.timeoutRuns(served)).toStrictEqual({
          timedOut: 1,
        })
        yield* pass(served)
        const before = yield* load(run.id)
        expect(before.children.map(({ status }) => status)).toStrictEqual([
          'cancelled',
          'cancelled',
          'cancelled',
        ])
        // The commands of the cancelled attempts are dropped unrun.
        expect(yield* execute(served)).toBe(3)
        expect(state.calls).toStrictEqual([])

        yield* Client.retry(run.id)
        yield* drain(served)
        const after = yield* load(run.id)
        expect(after.run).toMatchObject({
          status: 'completed',
          activeSince: 60_001,
          output: {
            own: 'own:"o" ok',
            job: 'job:"j" ok',
            child: 'child:"c" ok',
          },
        })
        expect(
          after.children.map(({ childRunId }) => childRunId),
        ).toStrictEqual(before.children.map(({ childRunId }) => childRunId))
        expect(state.calls.toSorted()).toStrictEqual([
          'child:"c"',
          'job:"j"',
          'own:"o"',
        ])
        // A fresh epoch: it is not overdue for having been once.
        expect(yield* Worker.timeoutRuns(served)).toStrictEqual({
          timedOut: 0,
        })
      }),
    )
  })
})

describe('a manual retry is refused', () => {
  const { handler } = world()
  const flow: WorkflowProgram = {
    kind: 'workflow',
    name: 'flow',
    timeout: '1m',
    steps: [
      {
        kind: 'workflow',
        name: 'child',
        workflow: { name: 'child' },
        input: () => 1,
        cancellation: 'detach',
      },
    ],
    result: ({ child }) => child,
  }
  const child: WorkflowProgram = {
    kind: 'workflow',
    name: 'child',
    steps: [activity('work', handler('work'))],
    result: ({ work }) => work,
  }

  it.effect(
    'for a run that is not a failed root, or not as it was seen',
    () => {
      const { served, provide } = setup([flow, child])

      return provide(
        Effect.gen(function* () {
          const refused = (runId: string, expectedVersion?: number) =>
            Effect.flip(
              Client.retry(
                runId,
                expectedVersion === undefined ? {} : { expectedVersion },
              ),
            )

          expect(yield* refused('run-404')).toStrictEqual(
            new RunNotFound({ runId: 'run-404' }),
          )
          const { run } = yield* start({ name: 'flow', input: null })
          expect(yield* refused(run.id)).toStrictEqual(
            new RunNotFailed({ runId: run.id, status: 'queued' }),
          )
          yield* pass(served)
          const childRunId = (yield* load(run.id)).children[0]!.childRunId!
          yield* cancel(childRunId)
          yield* pass(served)
          yield* pass(served)
          expect((yield* load(childRunId)).run.status).toBe('cancelled')
          expect(yield* refused(childRunId)).toStrictEqual(
            new RunNotRoot({ runId: childRunId }),
          )
          // A cancelled child cancels its parent, which is not a failure.
          const cancelled = (yield* load(run.id)).run
          expect(yield* refused(run.id)).toStrictEqual(
            new RunNotFailed({ runId: run.id, status: 'cancelled' }),
          )
          expect((yield* load(run.id)).run).toStrictEqual(cancelled)

          const other = yield* start({ name: 'flow', input: null })
          yield* TestClock.adjust(60_001)
          yield* Worker.timeoutRuns(served)
          const failed = (yield* load(other.run.id)).run
          const stale = yield* refused(other.run.id, failed.version - 1)
          expect(stale).toStrictEqual(
            new StaleRunVersion({
              runId: other.run.id,
              expectedVersion: failed.version - 1,
              version: failed.version,
            }),
          )
          expect(stale.message).toBe(
            `Stale retry version for run [${other.run.id}]`,
          )
          expect((yield* load(other.run.id)).run).toStrictEqual(failed)
          expect(
            yield* Client.retry(other.run.id, {
              expectedVersion: failed.version,
            }),
          ).toMatchObject({ status: 'queued' })
        }),
      )
    },
  )

  it.effect(
    'when the run was retried and failed again while it was looked over',
    () => {
      const { state, handler } = world()
      state.failing.add('work')
      const failing: WorkflowProgram = {
        kind: 'workflow',
        name: 'failing',
        steps: [activity('work', handler('work'))],
        result: ({ work }) => work,
      }
      const { served, provide, store } = setup([failing])
      // Another caller's retry, and the failure it comes to, land between
      // this one's look at the family and its commit.
      let raced = false
      const racing = (runId: string) =>
        Store.of({
          ...store,
          claimed: (runIds) =>
            Effect.gen(function* () {
              const held = yield* store.claimed(runIds)
              if (raced) return held
              raced = true
              yield* Effect.gen(function* () {
                yield* Client.retry(runId)
                yield* pass(served)
                yield* work(served, failed('again'))
                yield* pass(served)
              }).pipe(Effect.orDie, Effect.provideService(Store, store))
              return held
            }),
        })

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'failing', input: null })
          yield* drain(served)
          const seen = (yield* load(run.id)).run
          expect(seen.status).toBe('failed')

          const refused = yield* Effect.flip(
            Effect.provideService(Client.retry(run.id), Store, racing(run.id)),
          )
          // It decided on the first failure, and is not a retry of the next.
          const again = (yield* load(run.id)).run
          expect(refused).toStrictEqual(
            new StaleRunVersion({
              runId: run.id,
              expectedVersion: seen.version,
              version: again.version,
            }),
          )
          expect(again.status).toBe('failed')
          expect(again.version).toBeGreaterThan(seen.version)
        }),
      )
    },
  )

  it.effect('while a run of its family has not ended', () => {
    const { served, provide } = setup([flow, child])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: null })
        yield* pass(served)
        yield* pass(served)
        const childRunId = (yield* load(run.id)).children[0]!.childRunId!
        yield* TestClock.adjust(60_001)
        yield* Worker.timeoutRuns(served)
        const failed = yield* load(run.id)
        expect(failed.run.status).toBe('failed')
        // Detached, the child outlives the parent that timed out.
        expect((yield* load(childRunId)).run.status).toBe('running')

        const busy = yield* Effect.flip(Client.retry(run.id))
        expect(busy).toStrictEqual(
          new RunBusy({ runId: run.id, busyRunId: childRunId }),
        )
        expect(busy.message).toBe(
          `Run family [${run.id}] still has active work in run [${childRunId}]`,
        )
        expect(yield* load(run.id)).toStrictEqual(failed)

        yield* drain(served)
        expect((yield* load(childRunId)).run.status).toBe('completed')
        // The child completed meanwhile: its output is taken, not redone.
        yield* Client.retry(run.id)
        yield* drain(served)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'work:1 ok',
        })
      }),
    )
  })

  it.effect('while a worker still holds an attempt of the run', () => {
    const single: WorkflowProgram = { ...child, name: 'single', timeout: '1m' }
    const { served, provide } = setup([single])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'single', input: 1 })
        yield* pass(served)
        // A handler is running when the run is timed out under it.
        const [held] = yield* claimAttempts(served, 120_000)
        yield* TestClock.adjust(60_001)
        yield* Worker.timeoutRuns(served)
        const renewed = yield* Effect.flatMap(Store, (store) =>
          store.renew(held!, LEASE),
        )
        expect(renewed?.status).toBe('failed')

        expect(yield* Effect.flip(Client.retry(run.id))).toStrictEqual(
          new RunBusy({ runId: run.id, busyRunId: run.id }),
        )
        expect((yield* load(run.id)).run.status).toBe('failed')

        // Its lease over, the handler is gone or will be fenced.
        yield* TestClock.adjust(LEASE)
        expect(yield* Client.retry(run.id)).toMatchObject({ status: 'queued' })
      }),
    )
  })

  it.effect.each([['reject'] as const, ['join'] as const])(
    'when its unique key was taken since, even one that would %s',
    ([behavior]) => {
      const { state, handler: fresh } = world()
      const work: TaskProgram = {
        kind: 'task',
        name: 'work',
        execute: fresh('work'),
      }
      const { served, provide, inspect } = setup([work])
      const unique = { key: ['tenant', 1], behavior }

      return provide(
        Effect.gen(function* () {
          const begin = start({ kind: 'task', name: 'work', input: 1, unique })
          const { run } = yield* begin
          state.failing.add('work')
          yield* drain(served)
          const failed = yield* load(run.id)
          expect(failed.run.status).toBe('failed')

          // Failed, the run gave up its key, and another run has it now.
          const holder = yield* begin
          expect(holder).toMatchObject({ created: true })
          expect(yield* Effect.flip(Client.retry(run.id))).toStrictEqual(
            new RunConflict({
              runId: holder.run.id,
              status: 'queued',
              key: ['tenant', 1],
              scope: 'active',
            }),
          )
          expect(yield* load(run.id)).toStrictEqual(failed)

          // Once the key is free the retry takes it back with the run.
          yield* cancel(holder.run.id)
          yield* Client.retry(run.id)
          expect(inspect.keys().get('unique:active:["tenant",1]')).toBe(run.id)
          state.failing.clear()
          yield* drain(served)
          expect((yield* load(run.id)).run.status).toBe('completed')
          expect(inspect.keys().has('unique:active:["tenant",1]')).toBe(false)
        }),
      )
    },
  )
})
