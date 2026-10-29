import { cp, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { Store } from '@nmtjs/workflows'
import type { WorkflowsPlan } from '@nmtjs/workflows/neem'
import type * as Scope from 'effect/Scope'
import { Client } from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import type { SpawnedNeem } from '../../../neem/tests/e2e/support/e2e.ts'
import type { StoreSpec } from '../integration/fixtures/store.ts'
import {
  runNeem,
  spawnNode,
  waitFor,
} from '../../../neem/tests/e2e/support/e2e.ts'
import { createTempDir } from '../../../neem/tests/support/temp.ts'
import {
  generation,
  Order,
  orderOutput,
  orderSteps,
  recovery,
  revisionOutput,
} from '../integration/fixtures/app.ts'
import { storeLayer } from '../integration/fixtures/store.ts'
import {
  live,
  postgres,
  provision,
  reached,
  requireServices,
  settled,
  workspace,
} from '../integration/support.ts'

/**
 * The workers hosted as Neem worker threads, in production builds started
 * and stopped as deployments are: several at once, revisions on pools of
 * their own, a thread that is lost and replaced, and a stop that hands its
 * work on.
 */

requireServices([postgres])

/** A fixture built once for a test, started as often as it deploys. */
async function build() {
  // Inside the package, so that the fixture resolves workspace packages.
  const dir = await createTempDir(
    'case-',
    resolve(import.meta.dirname, '.neem'),
  )
  await cp(
    resolve(import.meta.dirname, '../integration/fixtures'),
    resolve(dir, 'fixtures'),
    {
      recursive: true,
    },
  )
  const outDir = resolve(dir, 'out')
  await runNeem([
    'build',
    '--config',
    resolve(dir, 'fixtures/neem/neem.config.ts'),
    '--outDir',
    outDir,
  ])
  return { outDir }
}

type Built = Awaited<ReturnType<typeof build>>

const output = (neem: SpawnedNeem) =>
  `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`

/** A layout of threads: a coordinator and one thread for each pool. */
const plan = (
  pools: readonly string[],
  options: {
    readonly leaseMs: number
    readonly concurrency?: number
    readonly cleanupTimeoutMs?: number
  },
): WorkflowsPlan => {
  const timing = { pollMs: 25, leaseMs: options.leaseMs }
  return {
    coordinator: { ...timing, concurrency: 4 },
    pools: Object.fromEntries(
      pools.map((pool) => [
        pool,
        {
          ...timing,
          concurrency: options.concurrency ?? 4,
          ...(options.cleanupTimeoutMs === undefined
            ? {}
            : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
        },
      ]),
    ),
  }
}

/** A deployment: the build started with what it serves, once it is ready. */
const deploy = (
  built: Built,
  spec: StoreSpec,
  env: Record<string, string>,
  deployed: string,
  layout: WorkflowsPlan,
) =>
  Effect.promise(async () => {
    const neem = spawnNode([resolve(built.outDir, 'start.js')], {
      env: {
        ...env,
        // Neem's logger is silent under `test`.
        NODE_ENV: 'production',
        WORKFLOWS_DEPLOYED: deployed,
        WORKFLOWS_PLAN: JSON.stringify(layout),
        // Every thread has a client of its own.
        WORKFLOWS_STORE: JSON.stringify({ ...spec, connections: 2 }),
      },
    })
    await waitFor(
      () => neem.stdout().includes('NEEM_SERVER_READY\n'),
      30_000,
      () => output(neem),
    )
    return neem
  })

/** Stops within Neem's own budget: a kill would not be a clean exit. */
const stop = (neem: SpawnedNeem) =>
  Effect.promise(async () => {
    const exit = await neem.stop({ killAfterMs: 15_000 })
    expect(exit, output(neem)).toEqual({ code: 0, signal: null })
  })

/** A test with a schema of its own and a build of the fixture. */
function hosted(
  name: string,
  body: (
    spec: StoreSpec,
    built: Built,
  ) => Effect.Effect<unknown, unknown, Store | Scope.Scope>,
  options: { readonly maxDeliveries?: number } = {},
) {
  it(
    name,
    () =>
      live(
        Effect.gen(function* () {
          const built = yield* Effect.promise(build)
          const spec = yield* provision(postgres, options)
          yield* Effect.scoped(
            Effect.provide(body(spec, built), storeLayer(spec)),
          )
        }),
      ),
    240_000,
  )
}

describe.skipIf(!postgres.url)('Neem hosting on PostgreSQL', () => {
  hosted(
    'routes each revision to its own pool across deployments and a crash',
    (spec, built) =>
      Effect.gen(function* () {
        const ws = yield* workspace
        const leaseMs = 1_000
        const layout = plan(['io', 'heavy'], { leaseMs })
        const v1 = generation('v1', 'io')
        const v2 = generation('v2', 'heavy')
        const pinned = Effect.fnUntraced(function* (
          runId: string,
          revision: string,
        ) {
          for (const { run } of yield* Client.getFamily(runId)) {
            expect(run.revision).toBe(revision)
          }
        })

        // The first deployment serves v2 only: v1 work waits, untouched.
        const parked = yield* Client.start(v1.Parent, 'x')
        let neem = yield* deploy(built, spec, ws.env, 'v2', layout)
        const current = yield* Client.start(v2.Parent, 'y')
        yield* reached(current.id, 'completed', { details: () => output(neem) })
        yield* Effect.sleep(leaseMs * 3)
        expect((yield* Client.get(parked.id))!.run.status).toBe('queued')
        expect(yield* Client.listDeadCommands()).toEqual({ commands: [] })
        yield* stop(neem)

        // The next serves both: the parked run resumes on v1 code.
        neem = yield* deploy(built, spec, ws.env, 'v1,v2', layout)
        const resumed = yield* reached(parked.id, 'completed', {
          details: () => output(neem),
        })
        expect(resumed.run.output).toEqual(revisionOutput('x', 'v1'))
        yield* pinned(parked.id, 'v1')

        // A v1 activity hangs, and the whole process is killed under it.
        const crashed = yield* Client.start(v1.Parent, 'hang-1')
        yield* Effect.promise(() =>
          waitFor(
            () => Effect.runPromise(ws.held('hang-1.v1')),
            30_000,
            () => output(neem),
          ),
        )
        neem.child.kill('SIGKILL')
        yield* Effect.promise(() => neem.waitForExit())

        // A deployment that lost v1 again takes over nothing of it, and
        // counts nothing against it.
        neem = yield* deploy(built, spec, ws.env, 'v2', layout)
        yield* Effect.sleep(leaseMs * 3)
        const held = (yield* Client.get(crashed.id))!
        expect(held.run.status).toBe('running')
        expect(held.attempts).toMatchObject([
          { nodeName: 'first', status: 'started', attemptNumber: 1 },
        ])
        expect(yield* Client.listDeadCommands()).toEqual({ commands: [] })
        yield* stop(neem)

        // Restored, the same attempt is delivered again and finishes.
        neem = yield* deploy(built, spec, ws.env, 'v1,v2', layout)
        const recovered = yield* reached(crashed.id, 'completed', {
          details: () => output(neem),
        })
        expect(recovered.run.output).toEqual(revisionOutput('hang-1', 'v1'))
        expect(recovered.attempts).toMatchObject([
          { nodeName: 'first', status: 'completed', attemptNumber: 1 },
        ])
        yield* pinned(crashed.id, 'v1')
        yield* stop(neem)

        // Every step ran on the pool of its revision's threads.
        const stamped = (yield* ws.events).filter(
          ({ event }) => event === 'stamped',
        )
        expect(new Set(stamped.map(({ revision }) => revision))).toEqual(
          new Set(['v1', 'v2']),
        )
        for (const { revision, servedBy } of stamped) {
          expect(servedBy).toBe(revision === 'v1' ? 'io' : 'heavy')
        }
      }),
    { maxDeliveries: 2 },
  )

  hosted(
    'replaces a thread whose handler outlived its cleanup, and finishes the work it held once',
    (spec, built) =>
      Effect.gen(function* () {
        const ws = yield* workspace
        const [timed, sibling] = recovery as [
          (typeof recovery)[number],
          (typeof recovery)[number],
        ]
        // Both are taken by the one thread of the pool.
        const runs = [
          yield* Client.start(timed, 1),
          yield* Client.start(sibling, 1),
        ]
        const neem = yield* deploy(
          built,
          spec,
          ws.env,
          'recovery',
          plan(['recovery'], {
            leaseMs: 1_000,
            concurrency: 2,
            cleanupTimeoutMs: 100,
          }),
        )

        for (const run of runs) {
          const records = yield* reached(run.id, 'completed', {
            details: () => output(neem),
          })
          expect(records.run.output).toBe(2)
          // The thread's loss made no failure and spent no retry: the same
          // attempt was delivered again, and completed.
          expect(records.attempts).toMatchObject([
            { status: 'completed', attemptNumber: 1 },
          ])
        }
        const events = yield* ws.events
        const lost = events.filter(({ event }) => event === 'held')
        expect(lost.map(({ name }) => name as string).toSorted()).toEqual([
          'sibling',
          'timed',
        ])
        const [{ thread }] = lost as [(typeof lost)[number]]
        expect(lost.every((event) => event.thread === thread)).toBe(true)
        // Its handlers may still have been using its services: they were
        // never released under them.
        expect(
          events
            .filter((event) => event.thread === thread)
            .map(({ event }) => event),
        ).not.toContain('release')
        const recovered = events.filter(({ event }) => event === 'recovered')
        expect(recovered).toHaveLength(2)
        for (const event of recovered) expect(event.thread).not.toBe(thread)
        yield* stop(neem)
      }),
  )

  hosted(
    'stops within its deadline, handing what it ran to the next deployment at once',
    (spec, built) =>
      Effect.gen(function* () {
        const ws = yield* workspace
        // Far longer than the test: only a hand-over explains a run that
        // goes on.
        const layout = plan(['orders', 'stamps'], { leaseMs: 120_000 })
        const input = {
          id: 'n1',
          items: ['a'],
          express: false,
          hold: 'activity' as const,
        }
        const neem = yield* deploy(built, spec, ws.env, 'order', layout)
        const run = yield* Client.start(Order, input)
        yield* Effect.promise(() =>
          waitFor(
            () => Effect.runPromise(ws.held('n1.activity')),
            30_000,
            () => output(neem),
          ),
        )

        const stoppingAt = Date.now()
        yield* stop(neem)
        expect(Date.now() - stoppingAt).toBeLessThan(15_000)
        const events = yield* ws.events
        expect(events.some(({ event }) => event === 'interrupted')).toBe(true)
        // Every thread that ran handlers released its services.
        expect(events.filter(({ event }) => event === 'release')).toHaveLength(
          events.filter(({ event }) => event === 'acquire').length,
        )

        const next = yield* deploy(built, spec, ws.env, 'order', layout)
        const { run: done } = yield* reached(run.id, 'completed', {
          timeoutMs: 30_000,
          details: () => output(next),
        })
        expect(done.output).toEqual(orderOutput(input))
        yield* stop(next)

        // A production build carries no development instrumentation.
        const files = yield* Effect.promise(() =>
          javaScriptFiles(resolve(built.outDir, 'runtime/workflows/worker')),
        )
        expect(files.length).toBeGreaterThan(0)
        const text = (yield* Effect.promise(() =>
          Promise.all(files.map((file) => readFile(file, 'utf8'))),
        )).join('\n')
        for (const marker of [
          '__rolldown_runtime__',
          'registerFactory',
          '__neem_accept_worker__',
        ]) {
          expect(text.includes(marker), marker).toBe(false)
        }
      }),
  )

  hosted(
    'serves one store from two deployments at once, every handler once',
    (spec, built) =>
      Effect.gen(function* () {
        const ws = yield* workspace
        const layout = plan(['orders', 'stamps'], { leaseMs: 30_000 })
        const deployments = [
          yield* deploy(built, spec, ws.env, 'order', layout),
          yield* deploy(built, spec, ws.env, 'order', layout),
        ]
        const details = () => deployments.map(output).join('\n')
        const inputs = Array.from({ length: 10 }, (_, index) => ({
          id: `m${index}`,
          items: ['a', 'b'],
          express: index % 2 === 0,
          hold: 'none' as const,
        }))
        const runs = yield* Effect.all(
          inputs.map((input) => Client.start(Order, input)),
          { concurrency: 'unbounded' },
        )
        for (const [index, run] of runs.entries()) {
          const { run: done } = yield* reached(run.id, 'completed', {
            timeoutMs: 60_000,
            details,
          })
          expect(done.output).toEqual(orderOutput(inputs[index]!))
        }
        const events = yield* ws.events
        const ran = events.filter(({ event }) => event === 'ran')
        expect(ran.map(({ step }) => step as string).toSorted()).toEqual(
          inputs.flatMap(orderSteps).toSorted(),
        )
        expect(new Set(ran.map(({ pid }) => pid))).toEqual(
          new Set(deployments.map(({ child }) => child.pid)),
        )
        const family = (yield* Client.list({ limit: 1_000 })).runs
        expect(yield* settled(family.map(({ id }) => id))).toEqual({
          dead: [],
          claimed: [],
        })
        for (const neem of deployments) yield* stop(neem)
      }),
  )
})

async function javaScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await javaScriptFiles(file)))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file)
  }
  return files
}
