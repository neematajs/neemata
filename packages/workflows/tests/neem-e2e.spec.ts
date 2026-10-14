import { randomUUID } from 'node:crypto'
import { cp, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { stripVTControlCharacters } from 'node:util'

import { PgClient } from '@effect/sql-pg'
// The fixture is built against the package's exports, so the test reads its
// runs with the same build of the engine.
import { Client, decodeRun } from '@nmtjs/workflows'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vitest'

import type { SpawnedNeem } from '../../neem/tests/e2e/support/e2e.ts'
import {
  editWorkerFile,
  runNeem,
  spawnNeem,
  spawnNode,
  waitFor,
} from '../../neem/tests/e2e/support/e2e.ts'
import { createTempDir } from '../../neem/tests/support/temp.ts'
import { Greeting } from './fixtures/neem/app.ts'

const serverReady = 'NEEM_SERVER_READY\n'
const modes = ['production', 'development'] as const
type Mode = (typeof modes)[number]

/** What the planner of the fixture lays out, as Neem names its threads. */
const threads = [
  'workflows:coordinator:0',
  'workflows:execution:0',
  'workflows:execution:1',
  'workflows:execution:2',
]

type Recorded = {
  readonly event: string
  readonly generation: string
  readonly thread: number
  readonly name?: string
  readonly role?: string
  readonly output?: unknown
}

async function createFixture(store?: 'postgres') {
  // Inside the package, so that the fixture resolves workspace packages.
  const dir = await createTempDir(
    'case-',
    resolve(import.meta.dirname, '.neem'),
  )
  const fixtureDir = resolve(dir, 'fixture')
  await cp(resolve(import.meta.dirname, 'fixtures/neem'), fixtureDir, {
    recursive: true,
  })
  if (store) {
    await cp(
      resolve(fixtureDir, `store.${store}.ts`),
      resolve(fixtureDir, 'store.ts'),
    )
  }
  const eventsFile = resolve(dir, 'events.jsonl')
  return {
    fixtureDir,
    configFile: resolve(fixtureDir, 'neem.config.ts'),
    outDir: resolve(dir, 'out'),
    env: { WORKFLOWS_EVENTS_FILE: eventsFile },
    async events(): Promise<Recorded[]> {
      const text = await readFile(eventsFile, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function boot(fixture: Fixture, mode: Mode, env: NodeJS.ProcessEnv = {}) {
  const { configFile, outDir } = fixture
  const args = ['--config', configFile, '--outDir', outDir]
  if (mode === 'development') {
    return spawnNeem(['dev', ...args], { env: { ...fixture.env, ...env } })
  }
  await runNeem(['build', ...args])
  return spawnNode([resolve(outDir, 'start.js')], {
    env: { ...fixture.env, ...env },
  })
}

const output = (neem: SpawnedNeem) =>
  `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`

const ready = (neem: SpawnedNeem) =>
  waitFor(
    () => neem.stdout().includes(serverReady),
    30_000,
    () => output(neem),
  )

/** Stops within Neem's own budget: a kill would not be a clean exit. */
async function stop(neem: SpawnedNeem) {
  const exit = await neem.stop({ killAfterMs: 15_000 })
  expect(exit, output(neem)).toEqual({ code: 0, signal: null })
}

const sorted = <A extends string | number>(values: readonly A[]) =>
  values.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** The threads that recorded an event, by the names Neem gave them. */
const named = (events: readonly Recorded[], event: string) =>
  sorted(
    events
      .filter((recorded) => recorded.event === event)
      .map(({ name }) => name!),
  )

describe.each(modes)('Neem hosting the workflow workers in %s', (mode) => {
  it('plans the threads, runs what each serves and stops them cleanly', async () => {
    const fixture = await createFixture()
    const neem = await boot(fixture, mode, {
      WORKFLOWS_SELF_START: '1',
      // Neem's default logger is silent under `test`.
      NODE_ENV: 'production',
    })
    await ready(neem)

    // Each thread of the `heavy` pool has a store of its own, started a run
    // of the task it serves and ran it to its end.
    const events = await waitFor(
      async () => {
        const events = await fixture.events()
        return named(events, 'completed').length === 2 ? events : undefined
      },
      30_000,
      () => output(neem),
    )
    expect(named(events, 'acquired')).toStrictEqual(threads)
    const acquired = events.filter(({ event }) => event === 'acquired')
    const completed = events.filter(({ event }) => event === 'completed')
    const heavy = acquired
      .filter(({ name }) => /execution:[12]$/.test(name!))
      .map(({ thread }) => thread)
    expect(
      completed.map(({ thread, output }) => ({ thread, output })),
    ).toStrictEqual(
      completed.map(({ thread }) => ({
        thread,
        output: { text: 'HELLO', thread },
      })),
    )
    expect(sorted(completed.map(({ thread }) => thread))).toStrictEqual(
      sorted(heavy),
    )
    // Handlers log through the logger Neem gave each worker, and nowhere
    // else: every line is one that logger wrote, under its thread's label.
    const logged = stripVTControlCharacters(neem.stdout())
      .split('\n')
      .filter((line) => line.includes('shouting hello'))
    expect(logged).toHaveLength(2)
    for (const line of logged) {
      expect(line).toMatch(
        /\[runtime:workflows:execution:[12]\] shouting hello$/,
      )
    }

    await stop(neem)
    expect(named(await fixture.events(), 'released')).toStrictEqual(threads)
  }, 90_000)

  it.each([
    {
      registry: 'undeclared-pool',
      error:
        'Execution pools [unplanned] named by declarations are not declared',
    },
    {
      registry: 'incomplete',
      error:
        'Tasks [neem.unregistered] referenced by registered workflows are not registered',
    },
  ])(
    'refuses to boot the $registry registry',
    async ({ registry, error }) => {
      const fixture = await createFixture()
      const neem = await boot(fixture, mode, { WORKFLOWS_REGISTRY: registry })

      const exit = await neem.waitForExit()
      // A child can exit before its piped output has been read.
      await Promise.all([
        finished(neem.child.stdout!),
        finished(neem.child.stderr!),
      ])
      expect(exit.signal, output(neem)).toBeNull()
      expect(exit.code, output(neem)).not.toBe(0)
      expect(neem.stderr(), output(neem)).toContain(error)
      expect(neem.stdout(), output(neem)).not.toContain(serverReady)
      // Refused before any thread acquired its store.
      expect(await fixture.events()).toStrictEqual([])
    },
    90_000,
  )
})

it('replaces the workers of an edited worker in development, stopping the old ones cleanly', async () => {
  const fixture = await createFixture()
  const neem = await boot(fixture, 'development', {
    WORKFLOWS_SELF_START: '1',
  })
  await ready(neem)
  await waitFor(
    async () => named(await fixture.events(), 'completed').length === 2,
    30_000,
    () => output(neem),
  )

  await editWorkerFile(
    neem,
    resolve(fixture.fixtureDir, 'workflows.worker.ts'),
    (source) => source.replace('generation-1', 'generation-2'),
  )

  const events = await waitFor(
    async () => {
      const events = await fixture.events()
      const next = events.filter(
        ({ generation }) => generation === 'generation-2',
      )
      return named(next, 'completed').length === 2 ? events : undefined
    },
    60_000,
    () => output(neem),
  )
  const of = (events: readonly Recorded[], generation: string) =>
    events.filter((recorded) => recorded.generation === generation)
  // Every worker of the old generation released what it held, and the new
  // ones serve in its place.
  expect(named(of(events, 'generation-1'), 'released')).toStrictEqual(threads)
  expect(named(of(events, 'generation-2'), 'acquired')).toStrictEqual(threads)

  await stop(neem)
  expect(
    named(of(await fixture.events(), 'generation-2'), 'released'),
  ).toStrictEqual(threads)
}, 120_000)

const url = process.env.POSTGRES_URL

it.skipIf(!url)(
  'completes a workflow across the planned threads on PostgreSQL',
  async () => {
    const schema = `workflows_neem_${randomUUID().replaceAll('-', '')}`
    // A schema of its own, dropped when the test ends: the database is
    // shared and is left as it was found.
    const database = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* Effect.acquireRelease(
          sql.unsafe(`CREATE SCHEMA ${schema}`),
          () => Effect.orDie(sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)),
        )
        yield* Postgres.install
      }),
    ).pipe(
      Layer.provideMerge(
        PgClient.layer({
          url: Redacted.make(url!),
          startupParameters: { search_path: schema },
          maxConnections: 2,
        }),
      ),
    )
    const store = Postgres.layer({ channel: `hints_${schema}` }).pipe(
      Layer.provide(database),
    )

    const fixture = await createFixture('postgres')
    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const neem = spawnNode([resolve(fixture.outDir, 'start.js')], {
          env: { ...fixture.env, WORKFLOWS_SCHEMA: schema },
        })
        yield* Effect.promise(() => ready(neem))

        const started = yield* Client.start(Greeting, 'Ada')
        const run = yield* Effect.gen(function* () {
          for (;;) {
            const records = yield* Client.get(started.id)
            if (records?.run.status === 'completed') return records.run
            yield* Effect.sleep('50 millis')
          }
        }).pipe(
          Effect.timeout('30 seconds'),
          Effect.tapError(() => Effect.sync(() => console.error(output(neem)))),
        )
        const { greeted, shouted } = decodeRun(Greeting, run).output!
        expect(greeted.text).toBe('Hello, Ada')
        expect(shouted.text).toBe('HELLO, ADA')

        // The activity ran on the thread of its workflow's pool, the task on
        // one of the two of its own: no step ran where the run was advanced.
        const acquired = (yield* Effect.promise(() => fixture.events())).filter(
          ({ event }) => event === 'acquired',
        )
        const threadOf = (name: string) =>
          acquired.find((recorded) => recorded.name === name)!.thread
        expect(greeted.thread).toBe(threadOf('workflows:execution:0'))
        expect([
          threadOf('workflows:execution:1'),
          threadOf('workflows:execution:2'),
        ]).toContain(shouted.thread)

        yield* Effect.promise(() => stop(neem))
        expect(
          named(yield* Effect.promise(() => fixture.events()), 'released'),
        ).toStrictEqual(threads)
      }).pipe(Effect.provide(store)),
    )
  },
  120_000,
)
