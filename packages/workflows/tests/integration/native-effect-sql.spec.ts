import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { NodeCrypto } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'
import { DurableDeferred } from 'effect/workflow'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EntryKind } from '../../src/native-effect/inspect.ts'
import type { Probe } from '../fixtures/native-effect/app.ts'
import {
  awaitWithin,
  defineWorkflow,
  retryStep,
  signal,
  SignalInterrupted,
  start,
  status,
  step,
  StepNotParked,
} from '../../src/native-effect/index.ts'
import { inspect } from '../../src/native-effect/inspect.ts'
import { layerCatalog, layerSql } from '../../src/native-effect/sql.ts'
import {
  Appeal,
  Approval,
  Archive,
  Crash,
  Declined,
  definitions,
  handlers,
  Invoice,
  Nap,
  Proof,
  Review,
  Ship,
  Verdict,
} from '../fixtures/native-effect/app.ts'
import {
  Codec,
  StampedOnRead,
  StampedOnWrite,
  waitFor,
} from '../support/native-effect.ts'

// Kept apart from the shared integration helpers, which load the existing
// engine's Postgres adapter.
const postgresTarget = { url: process.env.POSTGRES_URL }
if (!postgresTarget.url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
  throw new Error('Native Effect integration tests require POSTGRES_URL')
}

const pools = ['default', 'render']
// Short ownership timings keep takeover observable within a test.
const sharding = {
  shardsPerGroup: 8,
  shardLockExpiration: '3 seconds',
  shardLockRefreshInterval: '1 second',
  refreshAssignmentsInterval: '500 millis',
} as const

type Event = { readonly event: string; readonly slot: number }

describe.skipIf(!postgresTarget.url)('native Effect workflows on SQL', () => {
  let prefix: string
  let dir: string
  let events: Event[]
  // Shared by every runner, so a step blocked on one is free on the next.
  let released: boolean
  let cleanups: Array<() => Promise<unknown>>

  const database = Layer.mergeAll(
    PgClient.layer({
      url: Redacted.make(postgresTarget.url!),
      maxConnections: 6,
    }),
    NodeCrypto.layer,
  )

  function probe(slot: number): Probe {
    const isReleased = Effect.sync(() => released)
    return {
      record: (event) => Effect.sync(() => void events.push({ event, slot })),
      isReleased,
      released: isReleased.pipe(
        Effect.repeat({
          until: (open) => open,
          schedule: Schedule.spaced('10 millis'),
        }),
        Effect.asVoid,
      ),
    }
  }

  function engine(slot: number, served: readonly string[]) {
    return layerSql({
      prefix,
      pools,
      runner: { host: 'test', slot, pools: served },
      pollInterval: '100 millis',
      terminationTimeout: '1 second',
      sharding,
    })
  }

  /** An in-process runner with its own cluster identity and connections. */
  function runner(slot: number, served: readonly string[]) {
    const registered = handlers(probe(slot))
    const layers = served.map((pool) =>
      pool === 'render' ? registered.render : registered.default,
    )
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(layerCatalog(definitions), ...layers).pipe(
        Layer.provideMerge(engine(slot, served)),
        Layer.provideMerge(database),
      ),
    )
    cleanups.push(() => runtime.dispose())
    return runtime
  }

  function client() {
    const runtime = ManagedRuntime.make(
      layerSql({ prefix, pools, sharding }).pipe(Layer.provideMerge(database)),
    )
    cleanups.push(() => runtime.dispose())
    return runtime
  }

  function seen(event: string) {
    return events.filter((entry) => entry.event === event)
  }

  /** Polls the journal until the engine has stored a finished entry. */
  function journaled(executionId: string, kind: EntryKind, name: string) {
    return inspect(Appeal, executionId, { prefix }).pipe(
      Effect.repeat({
        until: (journal) =>
          journal.some(
            (entry) =>
              entry.kind === kind &&
              entry.name === name &&
              entry.state === 'succeeded',
          ),
        schedule: Schedule.spaced('100 millis'),
      }),
      Effect.timeout('20 seconds'),
    )
  }

  beforeEach(async () => {
    prefix = `nmtjs_native_${randomBytes(4).toString('hex')}`
    dir = await mkdtemp(resolve(tmpdir(), 'nmtjs-native-effect-'))
    events = []
    released = false
    cleanups = []
  })

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    await rm(dir, { recursive: true, force: true })

    const admin = new pg.Client({ connectionString: postgresTarget.url })
    await admin.connect()
    const { rows } = await admin.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE $1`,
      [`${prefix}%`],
    )
    for (const { tablename } of rows) {
      await admin.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`)
    }
    await admin.end()
  })

  it('places a task on the runner that serves its pool', async () => {
    const orders = runner(1, ['default'])
    const renderer = runner(2, ['render'])
    await orders.runPromise(Effect.void)
    await renderer.runPromise(Effect.void)

    const result = await client().runPromise(
      Effect.gen(function* () {
        const id = yield* start(Invoice, { invoice: '254' })
        yield* waitFor(Invoice, id, 'Suspended', '20 seconds')
        yield* signal(Invoice, id, Approval, Exit.succeed(true))
        const done = yield* waitFor(Invoice, id, 'Succeeded', '20 seconds')

        const journal = yield* inspect(Invoice, id, { prefix })
        return { done, journal }
      }),
    )

    expect(result.done.value).toBe('receipt://254')
    // The parent never ran the task's step, and the task ran exactly once.
    expect(seen('prepare:254')).toEqual([{ event: 'prepare:254', slot: 1 }])
    expect(seen('render:254')).toEqual([{ event: 'render:254', slot: 2 }])

    const entries = result.journal.map(({ kind, name, state }) => ({
      kind,
      name,
      state,
    }))
    expect(entries).toContainEqual({
      kind: 'activity',
      name: 'prepare',
      state: 'succeeded',
    })
    expect(entries).toContainEqual({
      kind: 'signal',
      name: 'approval',
      state: 'succeeded',
    })
    expect(entries).toContainEqual({
      kind: 'run',
      name: 'native.invoice',
      state: 'succeeded',
    })
  })

  it('routes a signal from a fresh client to a workflow outside the default pool', async () => {
    const renderer = runner(2, ['render'])
    await renderer.runPromise(Effect.void)
    const starter = client()
    const id = await starter.runPromise(
      Effect.gen(function* () {
        const id = yield* start(Proof, { name: 7, exit: 'door' })
        yield* waitFor(Proof, id, 'Suspended', '20 seconds')
        return id
      }),
    )

    // This client has never started or polled the definition, so the engine
    // in it learns the workflow's pool only from the signal call itself.
    const operator = client()
    const result = await operator.runPromise(
      Effect.gen(function* () {
        yield* signal(Proof, id, Approval, Exit.succeed(true))
        const done = yield* waitFor(Proof, id, 'Succeeded', '20 seconds')
        const journal = yield* inspect(Proof, id, { prefix })
        return { done, journal }
      }),
    )

    expect(result.done.value).toBe('door')
    expect(result.journal.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: 'run', name: 'native.proof' },
      { kind: 'signal', name: 'approval' },
    ])
  })

  it('starts a workflow only if the surrounding transaction commits', async () => {
    const local = runner(1, pools)
    await local.runPromise(Effect.void)
    const remote = client()
    const admin = new pg.Client({ connectionString: postgresTarget.url })
    await admin.connect()
    cleanups.push(() => admin.end())
    await admin.query(`CREATE TABLE "${prefix}_orders" (id TEXT PRIMARY KEY)`)

    function place(invoice: string, commit: boolean) {
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const write = Effect.gen(function* () {
          yield* sql`INSERT INTO ${sql(`${prefix}_orders`)} (id) VALUES (${invoice})`
          const id = yield* start(Invoice, { invoice })
          if (!commit) yield* Effect.fail('rollback' as const)
          return id
        })
        return yield* sql.withTransaction(write)
      })
    }

    // A caller in the runner's own process exercises local delivery; a
    // separate client exercises delivery through storage.
    for (const [name, caller] of [
      ['local', local],
      ['remote', remote],
    ] as const) {
      const rolledBack = await caller.runPromiseExit(place(`${name}-no`, false))
      expect(Exit.isFailure(rolledBack)).toBe(true)
      const committed = await caller.runPromise(place(`${name}-yes`, true))

      await caller.runPromise(
        waitFor(Invoice, committed, 'Suspended', '20 seconds'),
      )
      const abandoned = await caller.runPromise(
        Effect.gen(function* () {
          const id = yield* Invoice.executionId({ invoice: `${name}-no` })
          return yield* status(Invoice, id)
        }),
      )
      expect(abandoned._tag).toBe('Pending')
      expect(seen(`prepare:${name}-yes`)).toHaveLength(1)
      expect(seen(`prepare:${name}-no`)).toHaveLength(0)
    }

    const { rows } = await admin.query(
      `SELECT id FROM "${prefix}_orders" ORDER BY id`,
    )
    expect(rows).toEqual([{ id: 'local-yes' }, { id: 'remote-yes' }])

    // Give a phantom execution of a rolled-back start time to show itself.
    await new Promise((done) => setTimeout(done, 1_500))
    expect(seen('prepare:local-no')).toHaveLength(0)
    expect(seen('prepare:remote-no')).toHaveLength(0)
  })

  it('fires a durable timer after the runner that set it is gone', async () => {
    const first = runner(1, pools)
    const id = await first.runPromise(
      Effect.gen(function* () {
        const id = yield* start(Nap, { id: 'nap', millis: 2_500 })
        yield* waitFor(Nap, id, 'Suspended', '20 seconds')
        return id
      }),
    )
    expect(seen('before:nap')).toHaveLength(1)
    await first.dispose()

    const second = runner(1, pools)
    const done = await second.runPromise(
      waitFor(Nap, id, 'Succeeded', '30 seconds'),
    )

    expect(done.value).toBe('rested')
    expect(seen('before:nap')).toHaveLength(1)
    expect(seen('after:nap')).toHaveLength(1)
  })

  it('stops within its budget and hands a running step to the next runner', async () => {
    const first = runner(1, pools)
    const id = await first.runPromise(start(Crash, { id: 'stop' }))
    await waitForEvent(() => seen('hang:start:stop').length === 1)

    const stopping = Date.now()
    await first.dispose()
    // terminationTimeout is one second; the rest is storage and lock release.
    expect(Date.now() - stopping).toBeLessThan(8_000)

    released = true
    const second = runner(2, pools)
    const done = await second.runPromise(
      waitFor(Crash, id, 'Succeeded', '40 seconds'),
    )

    expect(done.value).toBe('recovered')
    expect(seen('first:stop')).toHaveLength(1)
    expect(seen('last:stop')).toEqual([{ event: 'last:stop', slot: 2 }])
    // The interrupted step has no stored result, so it runs again.
    expect(seen('hang:start:stop').length).toBeGreaterThanOrEqual(2)
  })

  it('takes the signal or the deadline, whichever the engine recorded first', async () => {
    const local = runner(1, pools)
    const result = await local.runPromise(
      Effect.gen(function* () {
        const answered = yield* start(Review, {
          doc: 'answered',
          millis: 60_000,
        })
        const ignored = yield* start(Review, { doc: 'ignored', millis: 1_000 })
        yield* waitFor(Review, answered, 'Suspended', '20 seconds')
        yield* signal(Review, answered, Approval, Exit.succeed(true))

        const first = yield* waitFor(
          Review,
          answered,
          'Succeeded',
          '20 seconds',
        )
        const second = yield* waitFor(
          Review,
          ignored,
          'Succeeded',
          '20 seconds',
        )
        const journal = yield* inspect(Review, ignored, { prefix })
        return { first, second, journal }
      }),
    )

    expect(result.first.value).toBe('approved')
    expect(result.second.value).toBe('expired')
    expect(result.journal.filter(({ kind }) => kind === 'timer')).toMatchObject(
      [{ name: 'review/deadline', state: 'succeeded' }],
    )
  })

  it('keeps a failed signal or a passed deadline, whichever came first, on another runner', async () => {
    const declined = Exit.fail(new Declined({ reason: 'budget' }))
    const first = runner(1, pools)
    const { early, late } = await first.runPromise(
      Effect.gen(function* () {
        const early = yield* start(Appeal, { doc: 'early', millis: 4_000 })
        const late = yield* start(Appeal, { doc: 'late', millis: 500 })
        yield* waitFor(Appeal, early, 'Suspended', '20 seconds')
        yield* signal(Appeal, early, Verdict, declined)

        // Both decisions are stored before either can be contradicted.
        yield* journaled(early, 'signal', 'raceAll/appeal')
        yield* journaled(late, 'signal', 'raceAll/appeal')
        yield* signal(Appeal, late, Verdict, declined)
        return { early, late }
      }),
    )
    await first.dispose()

    const second = runner(2, pools)
    const result = await second.runPromise(
      Effect.gen(function* () {
        // The losing deadline fires here and replays the body from storage.
        yield* journaled(early, 'timer', 'appeal/deadline')
        yield* signal(Appeal, early, Archive, Exit.void)
        yield* signal(Appeal, late, Archive, Exit.void)

        const failed = yield* waitFor(Appeal, early, 'Failed', '30 seconds')
        const expired = yield* waitFor(Appeal, late, 'Succeeded', '30 seconds')
        return { failed, expired }
      }),
    )

    expect(Cause.squash(result.failed.cause)).toMatchObject({
      _tag: 'Declined',
      reason: 'budget',
    })
    expect(result.expired.value).toBe('expired')
  })

  it('parks an exhausted step, retries it on request and can be interrupted', async () => {
    const local = runner(1, pools)
    await local.runPromise(
      Effect.gen(function* () {
        const id = yield* start(Ship, { order: 'a' })
        // The backoff between attempts suspends the workflow as well, so the
        // attempts are counted instead of waiting for a suspended status.
        yield* Effect.promise(() =>
          waitForEvent(() => seen('ship:a').length === 2),
        )

        const early = yield* Effect.flip(retryStep(Ship, id, 'reserve'))
        expect(early).toBeInstanceOf(StepNotParked)

        // The carrier is still down: the new budget is spent and it parks again.
        expect(yield* retryUntilParked(Ship, id, 'ship')).toBe(1)
        yield* Effect.promise(() =>
          waitForEvent(() => seen('ship:a').length === 4),
        )
        released = true
        expect(yield* retryUntilParked(Ship, id, 'ship')).toBe(2)

        const done = yield* waitFor(Ship, id, 'Succeeded', '20 seconds')
        expect(done.value).toBe('shipped')
        expect(seen('reserve:a')).toHaveLength(1)
        expect(seen('ship:a')).toHaveLength(5)

        const attempts = (yield* inspect(Ship, id, { prefix }))
          .filter(({ kind, name }) => kind === 'activity' && name === 'ship')
          .map(({ attempt, state }) => ({ attempt, state }))
        expect(attempts).toEqual([
          { attempt: 1, state: 'failed' },
          { attempt: 2, state: 'failed' },
          { attempt: 3, state: 'failed' },
          { attempt: 4, state: 'failed' },
          { attempt: 5, state: 'succeeded' },
        ])
      }),
    )

    released = false
    const interrupted = await local.runPromise(
      Effect.gen(function* () {
        const id = yield* start(Ship, { order: 'b' })
        yield* waitFor(Ship, id, 'Suspended', '20 seconds')
        yield* Ship.interrupt(id)
        return yield* waitFor(Ship, id, 'Interrupted', '20 seconds')
      }),
    )
    expect(interrupted._tag).toBe('Interrupted')
  })

  it('writes and reads results through schemas that need a service', async () => {
    const Sealed = defineWorkflow('native.sealed', {
      payload: { id: Schema.String },
      success: StampedOnRead,
      idempotencyKey: ({ id }) => id,
    })
    const live = Sealed.toLayer(() =>
      step({
        name: 'seal',
        success: StampedOnWrite,
        execute: Effect.succeed('receipt'),
      }),
    )
    // The catalog and the handler both ask for `Codec`: the catalog to read
    // the workflow's result, the handler to write the step's.
    const worker = ManagedRuntime.make(
      Layer.mergeAll(layerCatalog([Sealed]), live).pipe(
        Layer.provideMerge(engine(1, pools)),
        Layer.provideMerge(database),
        Layer.provide(Layer.succeed(Codec, { prefix: 'written:' })),
      ),
    )
    cleanups.push(() => worker.dispose())
    await worker.runPromise(Effect.void)

    const reader = ManagedRuntime.make(
      layerSql({ prefix, pools, sharding }).pipe(
        Layer.provideMerge(database),
        Layer.provideMerge(Layer.succeed(Codec, { prefix: 'read:' })),
      ),
    )
    cleanups.push(() => reader.dispose())
    const done = await reader.runPromise(
      Effect.gen(function* () {
        const id = yield* start(Sealed, { id: '1' })
        return yield* waitFor(Sealed, id, 'Succeeded', '20 seconds')
      }),
    )

    // Stored by the runner's codec, then read back by the client's.
    expect(done.value).toBe('read:written:receipt')
  })

  it('fails a run on a stored interruption or a nested step and keeps its status readable', async () => {
    const Wait = defineWorkflow('native.wait', {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
    })
    const Nested = defineWorkflow('native.nested', {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
    })
    const live = Layer.mergeAll(
      Wait.toLayer(() =>
        awaitWithin('wait', Approval, 600_000).pipe(Effect.as('answered')),
      ),
      Nested.toLayer(() =>
        step({
          name: 'outer',
          success: Schema.String,
          execute: step({
            name: 'inner',
            success: Schema.String,
            execute: Effect.succeed('inner'),
          }),
        }),
      ),
    )
    const local = ManagedRuntime.make(
      Layer.mergeAll(layerCatalog([Wait, Nested]), live).pipe(
        Layer.provideMerge(engine(1, pools)),
        Layer.provideMerge(database),
      ),
    )
    cleanups.push(() => local.dispose())

    const result = await local.runPromise(
      Effect.gen(function* () {
        const waiting = yield* start(Wait, { id: '1' })
        yield* waitFor(Wait, waiting, 'Suspended', '20 seconds')
        const refused = yield* Effect.flip(
          signal(Wait, waiting, Approval, Exit.interrupt()),
        )

        // Written past `signal`, the interruption is stored as given.
        const token = DurableDeferred.tokenFromExecutionId(Approval, {
          workflow: Wait,
          executionId: waiting,
        })
        yield* DurableDeferred.done(Approval, { token, exit: Exit.interrupt() })
        const interrupted = yield* waitFor(
          Wait,
          waiting,
          'Failed',
          '20 seconds',
        )

        const nesting = yield* start(Nested, { id: '1' })
        const nested = yield* waitFor(Nested, nesting, 'Failed', '20 seconds')
        return { refused, interrupted, nested }
      }),
    )

    expect(result.refused).toBeInstanceOf(SignalInterrupted)
    // A defect is stored as an error's name and message.
    expect(Cause.hasInterrupts(result.interrupted.cause)).toBe(false)
    expect(Cause.squash(result.interrupted.cause)).toMatchObject({
      name: 'SignalInterrupted',
      message: expect.stringContaining('Signal "approval"'),
    })
    expect(Cause.squash(result.nested.cause)).toMatchObject({
      name: 'NestedCheckpoint',
      message: expect.stringContaining(
        '"inner" is requested inside step "outer"',
      ),
    })
  })

  it('recovers an execution after its runner process is killed', async () => {
    const eventsFile = resolve(dir, 'events.jsonl')
    const releaseFile = resolve(dir, 'release')
    writeFileSync(eventsFile, '')

    function spawnRunner(slot: number) {
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, '../fixtures/native-effect/runner.ts')],
        {
          env: {
            ...process.env,
            POSTGRES_URL: postgresTarget.url,
            PREFIX: prefix,
            POOLS: pools.join(','),
            SLOT: String(slot),
            EVENTS_FILE: eventsFile,
            RELEASE_FILE: releaseFile,
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        },
      )
      cleanups.push(() => stop(child))
      return child
    }

    function recorded(event: string) {
      return readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): Event => JSON.parse(line))
        .filter((entry) => entry.event === event)
    }

    const doomed = spawnRunner(1)
    await waitForEvent(() => recorded('ready').length === 1)
    const remote = client()
    const id = await remote.runPromise(start(Crash, { id: 'kill' }))
    await waitForEvent(() => recorded('hang:start:kill').length === 1)

    // SIGKILL skips every finalizer: no lock release, no stored interruption.
    doomed.kill('SIGKILL')
    await new Promise((done) => doomed.once('exit', done))
    expect(existsSync(releaseFile)).toBe(false)

    spawnRunner(2)
    writeFileSync(releaseFile, '')
    const done = await remote.runPromise(
      waitFor(Crash, id, 'Succeeded', '50 seconds'),
    )

    expect(done.value).toBe('recovered')
    expect(recorded('first:kill')).toEqual([{ event: 'first:kill', slot: 1 }])
    expect(recorded('hang:done:kill')).toEqual([
      { event: 'hang:done:kill', slot: 2 },
    ])
    expect(recorded('last:kill')).toEqual([{ event: 'last:kill', slot: 2 }])
  })
})

/**
 * The step parks a moment after its last attempt is recorded, so the retry is
 * repeated until the engine reports it parked.
 */
function retryUntilParked(
  definition: typeof Ship,
  executionId: string,
  name: string,
) {
  return retryStep(definition, executionId, name).pipe(
    Effect.retry({
      while: (error) => error instanceof StepNotParked,
      schedule: Schedule.spaced('50 millis'),
      times: 100,
    }),
  )
}

async function waitForEvent(done: () => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for event')
    await new Promise((next) => setTimeout(next, 25))
  }
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise<void>((done) => {
    child.once('exit', () => done())
    child.kill('SIGTERM')
  })
}
