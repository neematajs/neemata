import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as TestClock from 'effect/testing/TestClock'

import type {
  AttemptCommand,
  Claim,
  Compute,
  Leaf,
  Plan,
  ReadScope,
  RunRecords,
  Step,
  StoredRun,
  TaskProgram,
  WorkflowProgram,
} from '../../src/index.ts'
import {
  cancel,
  coordinate,
  drain,
  settle,
  start,
  Store,
} from '../../src/index.ts'
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
} from '../support.ts'

type LeafOf<Kind extends Leaf['kind']> = Extract<Leaf, { kind: Kind }>
type MapStep = Extract<Step, { kind: 'map' }>

const same: Compute = (_outputs, input) => input

const activity = (leaf: Partial<LeafOf<'activity'>> = {}) =>
  ({ kind: 'activity', execute: unused, input: same, ...leaf }) as const

const task = (name: string, leaf: Partial<LeafOf<'task'>> = {}) =>
  ({ kind: 'task', task: { name }, input: same, ...leaf }) as const

const child = (name: string, leaf: Partial<LeafOf<'workflow'>> = {}) =>
  ({ kind: 'workflow', workflow: { name }, input: same, ...leaf }) as const

/** A workflow whose result is its steps' outputs, unless told otherwise. */
const flow = (
  name: string,
  steps: readonly Step[],
  result: Compute = (outputs) => ({ ...outputs }),
): WorkflowProgram => ({ kind: 'workflow', name, steps, result })

const embed: TaskProgram = { kind: 'task', name: 'embed', execute: unused }

/** A child workflow that stays in flight until its one activity is settled. */
const hold = flow('hold', [{ name: 'held', ...activity() }], ({ held }) => held)

/** A child workflow that ends on its first pass. */
const echo = flow('echo', [], same)

/** The children of one node, in the order they were created. */
const kids = (records: RunRecords, nodeName: string) =>
  records.children.filter((kid) => kid.nodeName === nodeName)

/** The claimed attempt of a child key, or of the task run with this id. */
function at(claims: readonly Claim<AttemptCommand>[], key: string) {
  const found = claims.find(
    ({ command }) => command.childKey === key || command.runId === key,
  )
  if (!found) throw new Error(`No claimed attempt at [${key}]`)
  return found
}

/** A wake with no news, as a duplicate delivery would be. */
const wake = ({ id: runId, name }: StoredRun) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ runs: [runId] }, () => ({
      _tag: 'Commit',
      result: undefined,
      mutation: {
        enqueue: [
          {
            command: { kind: 'continueRun', runId, name },
            dedupe: `continue:${runId}`,
          },
        ],
      },
    })),
  )

describe('a task run', () => {
  it.effect(
    'is one chain of attempts, and ends in the commit that ends the chain',
    () => {
      const { served, provide, inspect } = setup([embed])
      const unique = { key: ['doc-1'] } as const

      return provide(
        Effect.gen(function* () {
          const { run, created } = yield* start({
            kind: 'task',
            name: 'embed',
            input: 'text',
            unique,
            startAt: 500,
          })
          expect(created).toBe(true)
          expect(run).toMatchObject({ kind: 'task', status: 'queued' })

          const opened = yield* load(run.id)
          expect(opened.nodes).toMatchObject([
            { name: '$task', kind: 'task', status: 'running', input: 'text' },
          ])
          expect(opened.children).toMatchObject([
            { childKey: '$self', kind: 'task', attemptCount: 1 },
          ])
          // Nothing coordinates it: its only command is its attempt.
          expect(inspect.queue()).toMatchObject([
            { command: { kind: 'runTask', name: 'embed', runId: run.id } },
          ])

          expect(yield* claimAttempts(served)).toStrictEqual([])
          yield* TestClock.adjust(500)
          expect(yield* work(served, completed({ vector: 1 }))).toBe('settled')

          const ended = yield* load(run.id)
          expect(ended.run).toMatchObject({
            status: 'completed',
            output: { vector: 1 },
          })
          expect(ended.nodes).toMatchObject([{ status: 'completed' }])
          expect(ended.children).toMatchObject([{ status: 'completed' }])
          expect(ended.attempts).toMatchObject([{ status: 'completed' }])
          expect(inspect.queue()).toStrictEqual([])
          // The same commit freed the key the run held while it was active.
          const next = yield* start({
            kind: 'task',
            name: 'embed',
            input: 'text',
            unique,
          })
          expect(next.created).toBe(true)
        }),
      )
    },
  )

  it.effect('retries under its own policy and fails when that is spent', () => {
    const flaky: TaskProgram = {
      ...embed,
      retry: { attempts: 2, delay: '1s' },
    }
    const { served, provide, inspect } = setup([flaky])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'embed', input: 1 })

        expect(yield* work(served, failed('first'))).toBe('retrying')
        yield* TestClock.adjust(999)
        expect(yield* claimAttempts(served)).toStrictEqual([])
        yield* TestClock.adjust(1)
        expect(yield* work(served, failed('second'))).toBe('settled')

        const ended = yield* load(run.id)
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: { message: 'second' },
        })
        expect(ended.nodes).toMatchObject([{ status: 'failed' }])
        expect(ended.children).toMatchObject([
          { status: 'failed', attemptCount: 2 },
        ])
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect('is cancelled by the request itself when nothing runs it', () => {
    const { provide, inspect } = setup([embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'embed', input: 1 })

        expect(yield* cancel(run.id)).toMatchObject({ status: 'cancelled' })
        const ended = yield* load(run.id)
        expect(ended.nodes).toMatchObject([{ status: 'cancelled' }])
        expect(ended.children).toMatchObject([{ status: 'cancelled' }])
        expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
        // Its command is dropped by the next delivery's begin.
        expect(inspect.queue()).toHaveLength(1)
      }),
    )
  })

  it.effect('is cancelled once the handler that runs it has stopped', () => {
    const { served, provide, inspect } = setup([embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'embed', input: 1 })
        const [claim] = yield* claimAttempts(served)

        // Claimed, so its handler may be running: the run keeps its key.
        expect(yield* cancel(run.id)).toMatchObject({ status: 'cancelling' })
        const ending = yield* load(run.id)
        expect(ending.nodes).toMatchObject([{ status: 'cancelling' }])
        expect(ending.children).toMatchObject([{ status: 'cancelling' }])
        expect(ending.attempts).toMatchObject([{ status: 'started' }])

        // The outcome is discarded, and the handler is known to have ended.
        expect(yield* settle(served, claim!, completed(1))).toBe('stale')
        const ended = yield* load(run.id)
        expect(ended.run.status).toBe('cancelled')
        expect(ended.nodes).toMatchObject([{ status: 'cancelled' }])
        expect(ended.children).toMatchObject([{ status: 'cancelled' }])
        expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect('shares nothing with a workflow of the same name', () => {
    const acts = () => Effect.succeed('activity')
    const works = () => Effect.succeed('task')
    const programs = [
      flow('dup', [{ name: 'act', ...activity({ execute: acts }) }]),
      { kind: 'task', name: 'dup', execute: works },
    ] as const
    const { served, provide, inspect, store } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const key = { input: 1, idempotencyKey: ['k'] } as const
        const flowRun = (yield* start({ name: 'dup', ...key })).run
        // The key names the workflow's request; a task under it is another.
        expect(
          yield* Effect.exit(start({ kind: 'task', name: 'dup', ...key })),
        ).toStrictEqual(
          Exit.fail(expect.objectContaining({ _tag: 'IdempotencyConflict' })),
        )
        const taskRun = (yield* start({ kind: 'task', name: 'dup', input: 2 }))
          .run
        yield* pass(served)

        // A stray pass for the task run finds nothing of the workflow to do.
        const before = yield* load(taskRun.id)
        yield* wake(taskRun)
        expect(yield* pass(served)).toBe(1)
        expect(yield* load(taskRun.id)).toStrictEqual(before)

        // One route, yet a claim of the one kind never takes the other's.
        const routes = [{ name: 'dup' }]
        const claim = { limit: 100, leaseMs: LEASE }
        const activities = yield* store.claim({
          lanes: [{ kind: 'runAttempt', routes }],
          ...claim,
        })
        const tasks = yield* store.claim({
          lanes: [{ kind: 'runTask', routes }],
          ...claim,
        })
        expect(activities.map(({ command }) => command.runId)).toStrictEqual([
          flowRun.id,
        ])
        expect(tasks.map(({ command }) => command.runId)).toStrictEqual([
          taskRun.id,
        ])
        for (const taken of [...activities, ...tasks]) {
          yield* store.release(taken)
        }

        // Both kinds in one claim come in the order they were queued, the
        // task's attempt at its start and the activity's in the pass after
        // it, and the limit is for all of them together.
        const lanes = [
          { kind: 'runAttempt', routes },
          { kind: 'runTask', routes },
        ] as const
        const oldest = yield* store.claim({ lanes, limit: 1, leaseMs: LEASE })
        expect(oldest.map(({ command }) => command.kind)).toStrictEqual([
          'runTask',
        ])
        expect(
          (yield* store.claim({ lanes, ...claim })).map(
            ({ command }) => command.kind,
          ),
        ).toStrictEqual(['runAttempt'])
        for (const taken of oldest) yield* store.release(taken)
        expect(served.executable(activities[0]!.command)?.execute).toBe(acts)
        expect(served.executable(tasks[0]!.command)?.execute).toBe(works)
        // The stray pass left nothing behind but the two attempts.
        expect(inspect.queue()).toHaveLength(2)
      }),
    )
  })
})

describe('an activity being cancelled', () => {
  const flaky = flow('flaky', [
    { name: 'act', ...activity({ retry: { attempts: 2, delay: '1h' } }) },
  ])

  it.effect('ends at once when its next attempt only waits to be due', () => {
    const { served, provide } = setup([flaky])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flaky', input: 1 })
        yield* pass(served)
        expect(yield* work(served, failed('first'))).toBe('retrying')

        // Nothing holds the retry's command, so no handler of it runs: the
        // pass leaves the run waiting for it, and the drain after ends it.
        yield* cancel(run.id)
        yield* pass(served)
        const ended = yield* load(run.id)
        expect(ended.run.status).toBe('cancelled')
        expect(ended.nodes).toMatchObject([{ status: 'cancelled' }])
        expect(ended.attempts.map(({ status }) => status)).toStrictEqual([
          'failed',
          'cancelled',
        ])
      }),
    )
  })

  it.effect('waits for a handler that holds its command', () => {
    const { served, provide } = setup([flaky])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flaky', input: 1 })
        yield* pass(served)
        const [claim] = yield* claimAttempts(served)

        yield* cancel(run.id)
        yield* pass(served)
        const ending = yield* load(run.id)
        expect(ending.run.status).toBe('cancelling')
        expect(ending.children).toMatchObject([{ status: 'cancelling' }])
        expect(ending.attempts).toMatchObject([{ status: 'started' }])

        // The handler fails as it stops: the failure is not retried, and
        // ends the attempt the run waited for.
        expect(yield* settle(served, claim!, failed('stopped'))).toBe('stale')
        yield* pass(served)
        const ended = yield* load(run.id)
        expect(ended.run.status).toBe('cancelled')
        expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
      }),
    )
  })
})

describe('a task step', () => {
  const index = flow('index', [
    {
      name: 'embed',
      ...task('embed', { input: (_outputs, input) => [input] }),
    },
    { name: 'store', ...activity({ input: ({ embed }) => embed }) },
  ])

  it.effect(
    'starts a task run that wakes its parent in the commit that ends it',
    () => {
      const { served, provide, inspect } = setup([index, embed])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'index', input: 'text' })
          yield* pass(served)

          const waiting = yield* load(run.id)
          expect(waiting.run.status).toBe('waiting')
          expect(waiting.nodes).toMatchObject([
            { name: 'embed', kind: 'task', status: 'waiting', input: ['text'] },
          ])
          expect(waiting.children).toMatchObject([
            { childKey: '$self', kind: 'task', status: 'waiting' },
          ])
          const taskRunId = waiting.children[0]!.childRunId!
          expect((yield* load(taskRunId)).run).toMatchObject({
            kind: 'task',
            name: 'embed',
            input: ['text'],
            parentRunId: run.id,
            parentNodeName: 'embed',
            rootRunId: run.id,
          })
          // The task run has an attempt and no pass of its own.
          expect(inspect.queue()).toMatchObject([
            { command: { kind: 'runTask', runId: taskRunId } },
          ])

          expect(yield* work(served, completed('vector'))).toBe('settled')
          expect((yield* load(taskRunId)).run).toMatchObject({
            status: 'completed',
            output: 'vector',
          })
          expect(inspect.queue()).toMatchObject([
            { command: { kind: 'continueRun', runId: run.id } },
          ])

          expect(yield* pass(served)).toBe(1)
          expect((yield* load(run.id)).nodes).toMatchObject([
            { name: 'embed', status: 'completed', output: 'vector' },
            { name: 'store', status: 'running', input: 'vector' },
          ])
        }),
      )
    },
  )

  it.effect.each([
    {
      limits: "the task's own",
      step: {},
      expected: { retry: { attempts: 3, delay: '1s' }, timeout: '1m' },
    },
    {
      limits: "its step's, which replace the task's",
      step: { retry: { attempts: 2, delay: '2s' }, timeout: '5s' },
      expected: { retry: { attempts: 2, delay: '2s' }, timeout: '5s' },
    },
  ] as const)('runs its attempts under $limits', ({ step, expected }) => {
    const limited: TaskProgram = {
      ...embed,
      retry: { attempts: 3, delay: '1s' },
      timeout: '1m',
    }
    const program = flow('index', [{ name: 'embed', ...task('embed', step) }])
    const { served, provide } = setup([program, limited])
    const delay = Number.parseInt(expected.retry.delay) * 1_000

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'index', input: 1 })
        yield* pass(served)

        for (let attempt = 1; attempt <= expected.retry.attempts; attempt++) {
          const [claim] = yield* claimAttempts(served)
          expect(served.executable(claim!.command)).toMatchObject(expected)
          const last = attempt === expected.retry.attempts
          expect(yield* settle(served, claim!, failed(`#${attempt}`))).toBe(
            last ? 'settled' : 'retrying',
          )
          yield* TestClock.adjust(delay - 1)
          expect(yield* claimAttempts(served)).toStrictEqual([])
          yield* TestClock.adjust(1)
        }

        yield* pass(served)
        const { run: ended, nodes, children } = yield* load(run.id)
        const message = `#${expected.retry.attempts}`
        expect(ended).toMatchObject({ status: 'failed', error: { message } })
        expect(nodes).toMatchObject([{ status: 'failed', error: { message } }])
        expect(children).toMatchObject([{ status: 'failed' }])
        expect((yield* load(children[0]!.childRunId!)).attempts).toHaveLength(
          expected.retry.attempts,
        )
      }),
    )
  })

  it.effect('is cancelled, and its run with it, when its task run is', () => {
    const { served, provide } = setup([index, embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'index', input: 1 })
        yield* pass(served)
        const taskRunId = (yield* load(run.id)).children[0]!.childRunId!

        yield* cancel(taskRunId)
        expect(yield* pass(served)).toBe(1)

        const { run: ended, nodes, children } = yield* load(run.id)
        expect(ended.status).toBe('cancelled')
        expect(nodes).toMatchObject([{ name: 'embed', status: 'cancelled' }])
        expect(children).toMatchObject([{ status: 'cancelled' }])
      }),
    )
  })
})

describe('a branch', () => {
  const pack = (select: Compute<string>) =>
    flow('pack', [
      { name: 'price', ...activity() },
      {
        name: 'wrap',
        kind: 'branch',
        select,
        cases: {
          gift: activity({ input: ({ price }) => ({ gift: price }) }),
          plain: task('embed', { input: ({ price }) => ({ plain: price }) }),
        },
      },
      { name: 'ship', ...activity({ input: ({ wrap }) => wrap }) },
    ])

  it.effect('selects once, stores the choice, and runs that case only', () => {
    let choice = 'gift'
    let selections = 0
    const program = pack(() => {
      selections += 1
      return choice
    })
    const { served, provide } = setup([program, embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'pack', input: 5 })
        yield* pass(served)
        yield* work(served, completed(5))
        yield* pass(served)

        // Whatever would be selected now, the stored choice stands.
        choice = 'plain'
        yield* wake(run)
        yield* pass(served)
        const opened = yield* load(run.id)
        expect(opened.nodes[1]).toMatchObject({
          name: 'wrap',
          kind: 'branch',
          status: 'running',
          selectedCase: 'gift',
          input: { gift: 5 },
        })
        expect(kids(opened, 'wrap')).toMatchObject([
          { childKey: 'case:gift', kind: 'activity', input: { gift: 5 } },
        ])

        const [claim] = yield* claimAttempts(served)
        expect(claim!.command).toMatchObject({
          nodeName: 'wrap',
          childKey: 'case:gift',
          input: { gift: 5 },
        })
        const [, wrap] = program.steps
        expect(served.executable(claim!.command)).toBe(
          wrap!.kind === 'branch' && wrap.cases.gift,
        )
        yield* settle(served, claim!, completed('wrapped'))
        yield* pass(served)

        const moved = yield* load(run.id)
        expect(moved.nodes).toMatchObject([
          { name: 'price' },
          { name: 'wrap', status: 'completed', output: 'wrapped' },
          { name: 'ship', status: 'running', input: 'wrapped' },
        ])
        expect(kids(moved, 'wrap')).toHaveLength(1)
        expect(selections).toBe(1)
      }),
    )
  })

  it.effect('runs a task case as a task run and takes its output', () => {
    const { served, provide } = setup([pack(() => 'plain'), embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'pack', input: 5 })
        yield* pass(served)
        yield* work(served, completed(5))
        yield* pass(served)

        const opened = yield* load(run.id)
        expect(opened.run.status).toBe('waiting')
        expect(opened.nodes[1]).toMatchObject({
          status: 'waiting',
          selectedCase: 'plain',
        })
        const [wrapped] = kids(opened, 'wrap')
        expect(wrapped).toMatchObject({ childKey: 'case:plain', kind: 'task' })
        expect((yield* load(wrapped!.childRunId!)).run).toMatchObject({
          kind: 'task',
          input: { plain: 5 },
          parentNodeName: 'wrap',
        })

        yield* work(served, completed('boxed'))
        yield* pass(served)
        expect((yield* load(run.id)).nodes).toMatchObject([
          { name: 'price' },
          { name: 'wrap', status: 'completed', output: 'boxed' },
          { name: 'ship', input: 'boxed' },
        ])
      }),
    )
  })

  it.effect.each([
    {
      reason: 'the key is not a case',
      select: () => 'express',
      message: 'Unknown branch case [wrap.express]',
    },
    {
      reason: 'the key is only inherited by the cases',
      select: () => 'constructor',
      message: 'Unknown branch case [wrap.constructor]',
    },
    {
      reason: 'selecting throws',
      select: () => {
        throw new Error('no choice')
      },
      message: 'no choice',
    },
  ])('fails its node and the run when $reason', ({ select, message }) => {
    const { served, provide } = setup([pack(select), embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'pack', input: 5 })
        yield* pass(served)
        yield* work(served, completed(5))
        yield* pass(served)

        const ended = yield* load(run.id)
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: { message },
        })
        expect(ended.nodes[1]).toMatchObject({
          name: 'wrap',
          status: 'failed',
          error: { message },
        })
        expect(kids(ended, 'wrap')).toStrictEqual([])
      }),
    )
  })

  it.effect('fails with the error its child workflow failed with', () => {
    const broken = flow('broken', [], () => {
      throw new Error('boom')
    })
    const route = flow('route', [
      {
        name: 'go',
        kind: 'branch',
        select: () => 'sub',
        cases: { sub: child('broken') },
      },
    ])
    const { served, provide } = setup([route, broken])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'route', input: 1 })
        yield* pass(served)
        yield* pass(served)
        yield* pass(served)

        const { run: ended, nodes, children } = yield* load(run.id)
        const error = { message: 'boom' }
        expect(ended).toMatchObject({ status: 'failed', error })
        expect(nodes).toMatchObject([{ status: 'failed', error }])
        expect(children).toMatchObject([
          { childKey: 'case:sub', kind: 'workflow', status: 'failed', error },
        ])
      }),
    )
  })
})

describe('a parallel node', () => {
  const members = (all: Extract<Step, { kind: 'parallel' }>['members']) =>
    flow('fan', [{ name: 'all', kind: 'parallel', members: all }])

  it.effect(
    'starts every member at once and completes with all their outputs',
    () => {
      let computed = 0
      const program = flow('fan', [
        { name: 'first', ...activity() },
        {
          name: 'all',
          kind: 'parallel',
          members: {
            act: activity({
              input: (outputs) => {
                computed += 1
                // A member sees the steps before its node, never a sibling.
                return Object.keys(outputs)
              },
            }),
            job: task('embed', { input: ({ first }) => ({ job: first }) }),
            sub: child('hold', { input: ({ first }) => ({ sub: first }) }),
          },
        },
        { name: 'last', ...activity({ input: ({ all }) => all }) },
      ])
      const { served, provide } = setup([program, embed, hold])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'fan', input: 1 })
          yield* pass(served)
          yield* work(served, completed(1))
          yield* pass(served)

          const opened = yield* load(run.id)
          expect(opened.run.status).toBe('running')
          expect(opened.nodes[1]).toMatchObject({
            name: 'all',
            kind: 'parallel',
            status: 'running',
          })
          expect(kids(opened, 'all')).toMatchObject([
            {
              childKey: 'member:act',
              kind: 'activity',
              status: 'running',
              input: ['first'],
            },
            {
              childKey: 'member:job',
              kind: 'task',
              status: 'waiting',
              input: { job: 1 },
            },
            {
              childKey: 'member:sub',
              kind: 'workflow',
              status: 'waiting',
              input: { sub: 1 },
            },
          ])
          const [, job, sub] = kids(opened, 'all')

          // The child workflow opens its own step.
          yield* pass(served)
          const claims = yield* claimAttempts(served)
          expect(claims).toHaveLength(3)
          const [, all] = program.steps
          expect(served.executable(at(claims, 'member:act').command)).toBe(
            all!.kind === 'parallel' && all.members.act,
          )

          yield* settle(served, at(claims, job!.childRunId!), completed('J'))
          yield* pass(served)
          yield* settle(served, at(claims, 'member:act'), completed('A'))
          // The member is settled; its node waits for the others.
          const partial = yield* load(run.id)
          expect(kids(partial, 'all')).toMatchObject([
            { status: 'completed', output: 'A' },
            { status: 'completed', output: 'J' },
            { status: 'waiting' },
          ])
          expect(partial.nodes[1]!.status).toBe('running')

          yield* pass(served)
          const parked = yield* load(run.id)
          expect(parked.run.status).toBe('waiting')
          expect(parked.nodes[1]!.status).toBe('waiting')

          yield* settle(served, at(claims, sub!.childRunId!), completed('S'))
          yield* pass(served)
          yield* pass(served)
          const output = { act: 'A', job: 'J', sub: 'S' }
          const moved = yield* load(run.id)
          expect(moved.nodes[1]).toMatchObject({ status: 'completed' })
          expect(moved.nodes[1]!.output).toEqual(output)
          expect(moved.nodes[2]!.input).toEqual(output)
          expect(computed).toBe(1)
        }),
      )
    },
  )

  it.effect(
    'lets every member settle before it fails, with the first member`s error',
    () => {
      const program = members({
        a: activity(),
        b: activity(),
        sub: child('hold'),
      })
      const { served, provide } = setup([program, hold])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'fan', input: 1 })
          yield* pass(served)
          yield* pass(served)
          const claims = yield* claimAttempts(served)
          const subRunId = kids(yield* load(run.id), 'all')[2]!.childRunId!

          yield* settle(served, at(claims, 'member:b'), failed('b broke'))
          yield* pass(served)
          const afterFirst = yield* load(run.id)
          expect(afterFirst.run.status).toBe('running')
          expect(afterFirst.nodes).toMatchObject([{ status: 'running' }])
          expect(kids(afterFirst, 'all')).toMatchObject([
            { status: 'running' },
            { status: 'failed' },
            { status: 'waiting' },
          ])
          // The failure stopped nothing that was in flight.
          expect(
            afterFirst.attempts.map(({ childKey, status }) => [
              childKey,
              status,
            ]),
          ).toStrictEqual([
            ['member:a', 'started'],
            ['member:b', 'failed'],
          ])
          expect((yield* load(subRunId)).run.status).toBe('running')

          yield* settle(served, at(claims, 'member:a'), failed('a broke'))
          yield* pass(served)
          const afterSecond = yield* load(run.id)
          expect(afterSecond.run.status).toBe('waiting')
          expect(afterSecond.nodes).toMatchObject([{ status: 'waiting' }])

          yield* settle(served, at(claims, subRunId), completed('S'))
          yield* pass(served)
          yield* pass(served)
          const ended = yield* load(run.id)
          const error = { message: 'a broke' }
          expect(ended.run).toMatchObject({ status: 'failed', error })
          expect(ended.nodes).toMatchObject([{ status: 'failed', error }])
          expect(kids(ended, 'all')).toMatchObject([
            { status: 'failed' },
            { status: 'failed' },
            { status: 'completed', output: 'S' },
          ])
        }),
      )
    },
  )

  it.effect('fails only the member whose input cannot be computed', () => {
    const program = members({
      bad: activity({
        input: () => {
          throw new Error('no input')
        },
      }),
      ok: activity(),
    })
    const { served, provide } = setup([program])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'fan', input: 1 })
        yield* pass(served)

        const opened = yield* load(run.id)
        expect(opened.run.status).toBe('running')
        expect(kids(opened, 'all')).toMatchObject([
          { childKey: 'member:bad', status: 'failed', attemptCount: 0 },
          { childKey: 'member:ok', status: 'running' },
        ])

        yield* work(served, completed('fine'))
        yield* pass(served)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'failed',
          error: { message: 'no input' },
        })
      }),
    )
  })

  it.effect('gives each member a retry budget of its own', () => {
    const program = members({
      a: activity({ retry: { attempts: 2 } }),
      b: activity(),
    })
    const { served, provide } = setup([program])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'fan', input: 1 })
        yield* pass(served)
        const claims = yield* claimAttempts(served)

        expect(
          yield* settle(served, at(claims, 'member:a'), failed('a once')),
        ).toBe('retrying')
        expect(
          yield* settle(served, at(claims, 'member:b'), failed('b once')),
        ).toBe('settled')
        expect(yield* work(served, completed('A'))).toBe('settled')
        yield* pass(served)

        const ended = yield* load(run.id)
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: { message: 'b once' },
        })
        expect(kids(ended, 'all')).toMatchObject([
          { status: 'completed', attemptCount: 2 },
          { status: 'failed', attemptCount: 1 },
        ])
      }),
    )
  })

  it.effect('keeps apart children whose node and key only read alike', () => {
    // Joined by a slash, both children would be `a/member:x/$self`.
    const { served, provide } = setup([
      flow('alike', [
        {
          name: 'a',
          kind: 'parallel',
          members: { 'x/$self': activity({ input: () => 'member' }) },
        },
        { name: 'a/member:x', ...activity({ input: () => 'step' }) },
      ]),
    ])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'alike', input: null })
        yield* pass(served)
        yield* work(served, completed('of the member'))
        yield* pass(served)
        // The step has a child of its own to run, not the member's outcome.
        yield* work(served, completed('of the step'))
        yield* pass(served)

        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: {
            a: { 'x/$self': 'of the member' },
            'a/member:x': 'of the step',
          },
        })
      }),
    )
  })

  it.effect('keeps a member named like a property of every object', () => {
    const program = members({ ['__proto__']: activity(), plain: activity() })
    const { served, provide } = setup([program])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'fan', input: 1 })
        yield* pass(served)
        const claims = yield* claimAttempts(served)
        const inherited = at(claims, 'member:__proto__')
        expect(served.executable(inherited.command)).toBeDefined()

        yield* settle(served, inherited, completed('P'))
        yield* settle(served, at(claims, 'member:plain'), completed('Q'))
        yield* pass(served)

        const output = (yield* load(run.id)).nodes[0]!.output as object
        expect(Object.entries(output)).toStrictEqual([
          ['__proto__', 'P'],
          ['plain', 'Q'],
        ])
      }),
    )
  })

  const mixed = members({
    act: activity(),
    job: task('embed'),
    sub: child('hold'),
    free: child('hold', { cancellation: 'detach' }),
  })

  it.effect(
    'is cancelled with its run: attempts, task runs and child runs not detached',
    () => {
      const { served, provide } = setup([mixed, embed, hold])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'fan', input: 1 })
          yield* pass(served)
          yield* pass(served)
          const claims = yield* claimAttempts(served)
          const [, job, sub, free] = kids(yield* load(run.id), 'all')

          yield* cancel(run.id)
          yield* pass(served)

          // Everything is told to stop in one pass. The run, its node and each
          // child wait for what may still be running: the claimed attempt,
          // the task run whose attempt is claimed, and the child run that
          // settles in a pass of its own. Only the detached run is let go.
          const ended = yield* load(run.id)
          expect(ended.run.status).toBe('cancelling')
          expect(ended.nodes).toMatchObject([{ status: 'cancelling' }])
          expect(kids(ended, 'all').map(({ status }) => status)).toStrictEqual([
            'cancelling',
            'cancelling',
            'cancelling',
            'cancelled',
          ])
          expect(ended.attempts).toMatchObject([{ status: 'started' }])
          const jobRun = yield* load(job!.childRunId!)
          expect(jobRun.run.status).toBe('cancelling')
          expect(jobRun.attempts).toMatchObject([{ status: 'started' }])
          expect((yield* load(sub!.childRunId!)).run.status).toBe('cancelling')

          // Each handler that ends is the end of its attempt; what it came to
          // is discarded. A task run has no pass: it ends in that commit.
          expect(
            yield* settle(served, at(claims, 'member:act'), completed(1)),
          ).toBe('stale')
          expect(
            yield* settle(served, at(claims, job!.childRunId!), completed(1)),
          ).toBe('stale')
          const jobEnded = yield* load(job!.childRunId!)
          expect(jobEnded.run.status).toBe('cancelled')
          expect(jobEnded.attempts).toMatchObject([{ status: 'cancelled' }])

          yield* pass(served)
          expect((yield* load(sub!.childRunId!)).run.status).toBe('cancelling')
          expect(
            yield* settle(served, at(claims, sub!.childRunId!), completed(1)),
          ).toBe('stale')
          yield* pass(served)
          const subRun = yield* load(sub!.childRunId!)
          expect(subRun.run.status).toBe('cancelled')
          expect(subRun.attempts).toMatchObject([{ status: 'cancelled' }])
          const freeRun = yield* load(free!.childRunId!)
          expect(freeRun.run.status).toBe('running')
          expect(freeRun.attempts).toMatchObject([{ status: 'started' }])
          // The detached run is not waited for.
          yield* pass(served)
          const quiet = yield* load(run.id)
          expect(quiet.run.status).toBe('cancelled')
          expect(quiet.nodes).toMatchObject([{ status: 'cancelled' }])
          expect(kids(quiet, 'all').map(({ status }) => status)).toStrictEqual([
            'cancelled',
            'cancelled',
            'cancelled',
            'cancelled',
          ])
          expect((yield* load(run.id)).attempts).toMatchObject([
            { status: 'cancelled' },
          ])
        }),
      )
    },
  )

  it.effect(
    'is cancelled, and its siblings with it, when a member run is',
    () => {
      const { served, provide } = setup([mixed, embed, hold])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'fan', input: 1 })
          yield* pass(served)
          yield* pass(served)
          const [, job, sub, free] = kids(yield* load(run.id), 'all')

          yield* cancel(sub!.childRunId!)
          // The member ends in its own pass, the parent in the one that wakes:
          // nothing of either is claimed, so each is drained as its pass
          // leaves it, the parent with its task run.
          yield* pass(served)
          yield* pass(served)

          const ended = yield* load(run.id)
          expect(ended.run.status).toBe('cancelled')
          expect(ended.nodes).toMatchObject([{ status: 'cancelled' }])
          expect(kids(ended, 'all').map(({ status }) => status)).toStrictEqual([
            'cancelled',
            'cancelled',
            'cancelled',
            'cancelled',
          ])
          expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
          expect((yield* load(job!.childRunId!)).run.status).toBe('cancelled')
          expect((yield* load(free!.childRunId!)).run.status).toBe('running')
        }),
      )
    },
  )
})

describe('a map', () => {
  const each = (map: Partial<MapStep> = {}) =>
    flow('batch', [
      {
        name: 'each',
        kind: 'map',
        items: (_outputs, input) => input as readonly unknown[],
        input: (_outputs, _input, item) => ({ text: item }),
        target: { kind: 'task', task: { name: 'embed' } },
        ...map,
      },
      {
        name: 'after',
        ...activity({
          input: ({ each }) => (each as { items: unknown[] }).items.length,
        }),
      },
    ])

  const begin = (input: readonly unknown[]) => start({ name: 'batch', input })

  it.effect(
    'keeps at most `concurrency` items in flight and lists outputs in item order',
    () => {
      let listed = 0
      const started: number[] = []
      const program = each({
        concurrency: 2,
        items: (_outputs, input) => {
          listed += 1
          return input as readonly unknown[]
        },
        input: (_outputs, _input, item, index) => {
          started.push(index)
          return { text: item, index }
        },
      })
      const { served, provide } = setup([program, embed])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b', 'c'])
          yield* pass(served)

          const opened = yield* load(run.id)
          expect(opened.run.status).toBe('waiting')
          expect(opened.nodes).toMatchObject([
            {
              name: 'each',
              kind: 'mapTask',
              status: 'waiting',
              input: ['a', 'b', 'c'],
            },
          ])
          expect(opened.children).toMatchObject([
            {
              childKey: 'item:0',
              kind: 'task',
              status: 'waiting',
              ordinal: 0,
              item: 'a',
              input: { text: 'a', index: 0 },
            },
            { childKey: 'item:1', status: 'waiting', ordinal: 1, item: 'b' },
            { childKey: 'item:2', status: 'pending', ordinal: 2, item: 'c' },
          ])
          expect(opened.children[2]).not.toHaveProperty('childRunId')
          // An item's input is computed when the item starts.
          expect(started).toStrictEqual([0, 1])
          const [first, second] = opened.children.map((kid) => kid.childRunId!)
          expect((yield* load(second!)).run).toMatchObject({
            kind: 'task',
            input: { text: 'b', index: 1 },
            parentNodeName: 'each',
          })

          const claims = yield* claimAttempts(served)
          expect(claims).toHaveLength(2)
          yield* settle(served, at(claims, second!), completed('B'))
          yield* pass(served)

          // The settled item made room for the next one.
          const moved = yield* load(run.id)
          expect(moved.children.map(({ status }) => status)).toStrictEqual([
            'waiting',
            'completed',
            'waiting',
          ])
          expect(started).toStrictEqual([0, 1, 2])
          const third = moved.children[2]!.childRunId!

          yield* work(served, completed('C'))
          yield* pass(served)
          expect((yield* load(run.id)).nodes).toMatchObject([
            { status: 'waiting' },
          ])

          yield* settle(served, at(claims, first!), completed('A'))
          yield* pass(served)
          const ended = yield* load(run.id)
          expect(ended.nodes[0]!.output).toStrictEqual({
            items: [
              { item: 'a', index: 0, runId: first, output: 'A' },
              { item: 'b', index: 1, runId: second, output: 'B' },
              { item: 'c', index: 2, runId: third, output: 'C' },
            ],
          })
          expect(ended.nodes[1]).toMatchObject({ name: 'after', input: 3 })
          expect(listed).toBe(1)
        }),
      )
    },
  )

  it.effect(
    'fails an item whose run is gone, and goes on with the rest',
    () => {
      const { served, provide, store } = setup([
        each({ concurrency: 2 }),
        embed,
      ])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b'])
          yield* pass(served)
          // The edge of the first names a run no store holds, as an edge whose
          // run was lost would.
          yield* store.transact({ runs: [run.id] }, (snapshot) => {
            const [first] = snapshot.runs.get(run.id)!.children
            return {
              _tag: 'Commit',
              mutation: {
                children: [
                  {
                    ...first!,
                    childRunId: 'run-gone',
                    version: first!.version + 1,
                  },
                ],
              },
              result: undefined,
            }
          })
          const [, other] = (yield* load(run.id)).children
          const claims = yield* claimAttempts(served)
          const second = claims.find(
            ({ command }) => command.runId === other!.childRunId,
          )
          yield* settle(served, second!, completed('B'))
          yield* pass(served)

          const ended = yield* load(run.id)
          expect(ended.children.map(({ status }) => status)).toStrictEqual([
            'failed',
            'completed',
          ])
          expect(ended.run).toMatchObject({
            status: 'failed',
            error: { message: 'Missing child run [run-gone]' },
          })
        }),
      )
    },
  )

  it.effect('completes at once when there are no items', () => {
    const { served, provide } = setup([each(), embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin([])
        expect(yield* pass(served)).toBe(1)

        const { nodes, children } = yield* load(run.id)
        expect(nodes).toMatchObject([
          { name: 'each', status: 'completed', output: { items: [] } },
          { name: 'after', status: 'running', input: 0 },
        ])
        expect(children).toMatchObject([{ nodeName: 'after' }])
      }),
    )
  })

  it.effect(
    'keeps starting items after a failure and fails once all have settled',
    () => {
      const { served, provide } = setup([each({ concurrency: 1 }), embed])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b', 'c'])
          yield* pass(served)
          expect(
            (yield* load(run.id)).children.map(({ status }) => status),
          ).toStrictEqual(['waiting', 'pending', 'pending'])

          yield* work(served, failed('a broke'))
          yield* pass(served)
          const afterFirst = yield* load(run.id)
          expect(afterFirst.run.status).toBe('waiting')
          expect(afterFirst.children.map(({ status }) => status)).toStrictEqual(
            ['failed', 'waiting', 'pending'],
          )

          yield* work(served, completed('B'))
          yield* pass(served)
          yield* work(served, failed('c broke'))
          yield* pass(served)

          const ended = yield* load(run.id)
          const error = { message: 'a broke' }
          expect(ended.run).toMatchObject({ status: 'failed', error })
          expect(ended.nodes).toMatchObject([{ status: 'failed', error }])
          expect(ended.children.map(({ status }) => status)).toStrictEqual([
            'failed',
            'completed',
            'failed',
          ])
        }),
      )
    },
  )

  it.effect(
    'fails only the item whose input cannot be computed, without using its turn',
    () => {
      const program = each({
        concurrency: 1,
        input: (_outputs, _input, item) => {
          if (item === 'bad') throw new Error('bad item')
          return item
        },
      })
      const { served, provide } = setup([program, embed])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'bad', 'c'])
          yield* pass(served)
          yield* work(served, completed('A'))
          yield* pass(served)

          const moved = yield* load(run.id)
          expect(moved.run.status).toBe('waiting')
          expect(moved.children).toMatchObject([
            { status: 'completed' },
            { status: 'failed', item: 'bad', error: { message: 'bad item' } },
            { status: 'waiting', item: 'c', input: 'c' },
          ])
          expect(moved.children[1]).not.toHaveProperty('childRunId')

          yield* work(served, completed('C'))
          yield* pass(served)
          const ended = yield* load(run.id)
          const error = { message: 'bad item' }
          expect(ended.run).toMatchObject({ status: 'failed', error })
          expect(ended.nodes).toMatchObject([{ status: 'failed', error }])
        }),
      )
    },
  )

  it.effect(
    'fails its node and the run when its items cannot be computed',
    () => {
      const program = each({
        items: () => {
          throw new Error('no items')
        },
      })
      const { served, provide } = setup([program, embed])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin([])
          yield* pass(served)

          const { run: ended, nodes, children } = yield* load(run.id)
          const error = { message: 'no items' }
          expect(ended).toMatchObject({ status: 'failed', error })
          expect(nodes).toMatchObject([
            { kind: 'mapTask', status: 'failed', error },
          ])
          expect(children).toStrictEqual([])
        }),
      )
    },
  )

  it.effect('gives every item the retry budget its step declares', () => {
    const program = each({
      target: { ...task('embed'), retry: { attempts: 2 } },
    })
    const { served, provide } = setup([program, embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin(['a', 'b'])
        yield* pass(served)
        const [first, second] = (yield* load(run.id)).children.map(
          (kid) => kid.childRunId!,
        )

        const once = yield* claimAttempts(served)
        for (const claim of once) {
          expect(yield* settle(served, claim, failed('once'))).toBe('retrying')
        }
        const twice = yield* claimAttempts(served)
        yield* settle(served, at(twice, first!), completed('A'))
        expect(yield* settle(served, at(twice, second!), failed('twice'))).toBe(
          'settled',
        )
        yield* pass(served)

        const ended = yield* load(run.id)
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: { message: 'twice' },
        })
        expect(ended.children.map(({ status }) => status)).toStrictEqual([
          'completed',
          'failed',
        ])
        expect((yield* load(first!)).children).toMatchObject([
          { attemptCount: 2 },
        ])
      }),
    )
  })

  it.effect('starts one child workflow per item', () => {
    const program = each({ target: child('echo') })
    const { served, provide } = setup([program, echo])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin(['a', 'b'])
        yield* pass(served)
        const opened = yield* load(run.id)
        expect(opened.nodes).toMatchObject([{ kind: 'mapWorkflow' }])
        expect(opened.children).toMatchObject([
          { kind: 'workflow', status: 'waiting' },
          { kind: 'workflow', status: 'waiting' },
        ])
        const [first, second] = opened.children.map((kid) => kid.childRunId!)

        // The children end in their passes; the parent reads both in one.
        expect(yield* pass(served)).toBe(2)
        expect(yield* pass(served)).toBe(1)
        expect((yield* load(run.id)).nodes[0]!.output).toStrictEqual({
          items: [
            { item: 'a', index: 0, runId: first, output: { text: 'a' } },
            { item: 'b', index: 1, runId: second, output: { text: 'b' } },
          ],
        })
      }),
    )
  })

  it.effect.each([
    {
      policy: 'propagate',
      waits: 'cancelling',
      told: 'cancelling',
      ends: 'cancelled',
    },
    {
      policy: 'detach',
      waits: 'cancelled',
      told: 'cancelled',
      ends: 'running',
    },
  ] as const)(
    'is cancelled with its run, child workflows unless detached: $policy',
    ({ policy, waits, told, ends }) => {
      const program = each({
        concurrency: 2,
        target: child('hold', { cancellation: policy }),
      })
      const { served, provide } = setup([program, hold])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b', 'c'])
          yield* pass(served)
          yield* pass(served)
          const opened = yield* load(run.id)
          expect(opened.children[0]).toMatchObject({ cancellation: policy })
          const [first, second] = opened.children.map((kid) => kid.childRunId!)

          yield* cancel(run.id)
          yield* pass(served)
          const ended = yield* load(run.id)
          expect(ended.run.status).toBe(waits)
          expect(ended.nodes).toMatchObject([{ status: told }])
          // The item that was waiting for its turn never got a run.
          expect(ended.children).toMatchObject([
            { status: told },
            { status: told },
            { status: 'cancelled', item: 'c' },
          ])
          expect(ended.children[2]).not.toHaveProperty('childRunId')

          yield* pass(served)
          expect((yield* load(first!)).run.status).toBe(ends)
          expect((yield* load(second!)).run.status).toBe(ends)
          yield* pass(served)
          const quiet = yield* load(run.id)
          expect(quiet.run.status).toBe('cancelled')
          expect(quiet.nodes).toMatchObject([{ status: 'cancelled' }])
          expect(quiet.children.map(({ status }) => status)).toStrictEqual([
            'cancelled',
            'cancelled',
            'cancelled',
          ])
        }),
      )
    },
  )

  it.effect(
    'stops its items in work that grows with their number, not its square',
    () => {
      /** How often a pass that stops `width` items asks a record for its run. */
      const reads = (width: number) => {
        const { served, provide, store } = setup([each(), embed])
        let count = 0
        const counting = <Owned extends { readonly runId: string }>(
          record: Owned,
        ): Owned => {
          const { runId, ...rest } = record
          return Object.defineProperty({ ...rest }, 'runId', {
            enumerable: true,
            get: () => {
              count += 1
              return runId
            },
          }) as Owned
        }
        // The same store, with every record a plan is handed counting.
        const counted = Store.of({
          ...store,
          transact: (scope, plan) =>
            store.transact(scope, (snapshot) =>
              plan({
                ...snapshot,
                runs: new Map(
                  Array.from(snapshot.runs, ([id, records]) => [
                    id,
                    records && {
                      run: records.run,
                      nodes: records.nodes.map(counting),
                      children: records.children.map(counting),
                      attempts: records.attempts.map(counting),
                    },
                  ]),
                ),
              }),
            ),
        })

        return provide(
          Effect.gen(function* () {
            const { run } = yield* begin(Array.from({ length: width }))
            yield* pass(served)
            yield* cancel(run.id)
            yield* Effect.provideService(pass(served), Store, counted)
            // Its task runs, drained as the pass left them, wake it to end.
            yield* pass(served)
            expect((yield* load(run.id)).run.status).toBe('cancelled')
            return count
          }),
        )
      }

      return Effect.gen(function* () {
        const [narrow, wide] = [yield* reads(50), yield* reads(400)]
        // Eight times the items: eight times the work, where reading
        // everything loaded for each item made it sixty-four times.
        expect(wide / narrow).toBeLessThan(12)
      })
    },
  )

  it.effect(
    'reads, while its child runs end one by one, only those still ending',
    () => {
      const program = each({ target: child('hold') })
      const { served, provide, store } = setup([program, hold])
      // The runs of other ids than its own a pass of the map's run commits
      // having read, by head, with what an open read linked, or whole.
      let read: number[] = []
      const counted = Store.of({
        ...store,
        transact: (scope, plan) =>
          store.transact(scope, (snapshot) => {
            const planned = plan(snapshot)
            if (planned._tag !== 'Commit') return planned
            const ids = new Set([
              ...snapshot.heads.keys(),
              ...snapshot.runs.keys(),
            ])
            for (const records of snapshot.open.values()) {
              for (const id of records?.linked.keys() ?? []) ids.add(id)
            }
            for (const id of snapshot.open.keys()) ids.delete(id)
            read.push(ids.size)
            return planned
          }),
      })
      const passOfRun = Effect.provideService(pass(served), Store, counted)

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b', 'c', 'd', 'e'])
          yield* pass(served)
          yield* pass(served)
          yield* cancel(run.id)
          read = []
          expect(yield* passOfRun).toBe(1)
          expect(read).toStrictEqual([5])

          // Each child run ends in a pass of its own, drained as its
          // coordinator does, and the map's run reads what is left after each.
          const ending = yield* store.claim({
            lanes: [{ kind: 'continueRun', routes: served.workflows }],
            limit: 100,
            leaseMs: LEASE,
          })
          expect(ending).toHaveLength(5)
          read = []
          for (const claim of ending) {
            const result = yield* coordinate(served, claim)
            if (result._tag === 'Advanced' && result.draining) {
              yield* drain(result.draining)
            }
            expect(yield* passOfRun).toBe(1)
          }
          // A child run seen ended is read no more: the work of a pass is
          // what is still ending, not every child it once told.
          expect(read).toStrictEqual([5, 4, 3, 2, 1])
          const quiet = yield* load(run.id)
          expect(quiet.run.status).toBe('cancelled')
          expect(quiet.children.map(({ status }) => status)).toStrictEqual(
            Array.from({ length: 5 }, () => 'cancelled'),
          )
        }),
      )
    },
  )

  it.effect('cancels the task runs of its items in flight with its run', () => {
    const { served, provide } = setup([each({ concurrency: 2 }), embed])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin(['a', 'b', 'c'])
        yield* pass(served)
        const claims = yield* claimAttempts(served)
        const [first, second] = (yield* load(run.id)).children.map(
          (kid) => kid.childRunId!,
        )

        yield* cancel(run.id)
        yield* pass(served)

        // The item that never started is cancelled; the two task runs wait
        // for their handlers, and the run for them.
        const ending = yield* load(run.id)
        expect(ending.run.status).toBe('cancelling')
        expect(ending.children.map(({ status }) => status)).toStrictEqual([
          'cancelling',
          'cancelling',
          'cancelled',
        ])
        for (const taskRunId of [first!, second!]) {
          const taskRun = yield* load(taskRunId)
          expect(taskRun.run.status).toBe('cancelling')
          expect(taskRun.attempts).toMatchObject([{ status: 'started' }])
          expect(
            yield* settle(served, at(claims, taskRunId), completed(1)),
          ).toBe('stale')
          const ended = yield* load(taskRunId)
          expect(ended.run.status).toBe('cancelled')
          expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
        }

        yield* pass(served)
        const ended = yield* load(run.id)
        expect(ended.run.status).toBe('cancelled')
        expect(ended.children.map(({ status }) => status)).toStrictEqual([
          'cancelled',
          'cancelled',
          'cancelled',
        ])
      }),
    )
  })

  it.effect(
    'has all its child runs loaded together, not one plan for each',
    () => {
      const { served, provide, store } = setup([each(), embed])
      let plans = 0
      const counted = Store.of({
        ...store,
        transact: <A, E = never>(scope: ReadScope, plan: Plan<A, E>) =>
          store.transact(scope, (snapshot) => {
            plans += 1
            return plan(snapshot)
          }),
      })
      const once = Effect.fnUntraced(function* () {
        const [claim] = yield* store.claim({
          lanes: [{ kind: 'continueRun', routes: served.workflows }],
          limit: 1,
          leaseMs: LEASE,
        })
        plans = 0
        const result = yield* Effect.provideService(
          coordinate(served, claim!),
          Store,
          counted,
        )
        if (result._tag === 'Advanced' && result.draining) {
          yield* drain(result.draining)
        }
        return plans
      })

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b', 'c', 'd'])
          yield* pass(served)

          // The run, with the four child runs it reads.
          yield* wake(run)
          expect(yield* once()).toBe(1)
          // Cancelling reads what the run opened has in flight, and then
          // everything the four task runs own, together.
          yield* cancel(run.id)
          expect(yield* once()).toBe(2)
          // Its task runs, drained as the pass left them, wake it to end.
          yield* pass(served)
          expect((yield* load(run.id)).run.status).toBe('cancelled')
        }),
      )
    },
  )

  it.effect(
    'is never read whole while the handlers of its task runs stop one by one',
    () => {
      const { served, provide, store } = setup([each(), embed])
      let runId: string | undefined
      let whole = 0
      // Every plan, a drain's included, that is handed the map's run whole.
      const counted = Store.of({
        ...store,
        transact: (scope, plan) =>
          store.transact(scope, (snapshot) => {
            if (runId !== undefined && snapshot.runs.has(runId)) whole += 1
            return plan(snapshot)
          }),
      })
      const passOfRun = Effect.provideService(pass(served), Store, counted)

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin(['a', 'b', 'c', 'd'])
          yield* pass(served)
          const claims = yield* claimAttempts(served)
          runId = run.id

          yield* cancel(run.id)
          yield* passOfRun
          for (const claim of claims) {
            expect((yield* load(run.id)).run.status).toBe('cancelling')
            expect(yield* settle(served, claim, completed(1))).toBe('stale')
            yield* passOfRun
          }
          expect((yield* load(run.id)).run.status).toBe('cancelled')
          expect(whole).toBe(0)
        }),
      )
    },
  )
})
