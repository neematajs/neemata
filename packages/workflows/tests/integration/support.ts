import type { ChildProcess } from 'node:child_process'
import type { AddressInfo, Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { StoredRun } from '@nmtjs/workflows'
import type * as Scope from 'effect/Scope'
import * as NodeRedis from '@effect/platform-node/NodeRedis'
import { PgClient } from '@effect/sql-pg'
import { Client, isTerminal, Store } from '@nmtjs/workflows'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redis from 'effect/persistence/Redis'
import * as Redacted from 'effect/Redacted'
import * as SqlClient from 'effect/sql/SqlClient'
import { it } from 'vitest'

import type { Recorded } from './fixtures/app.ts'
import type { StoreSpec } from './fixtures/store.ts'
import type { WorkerConfig } from './fixtures/worker.ts'
import { holdMarker } from './fixtures/app.ts'
import { storeLayer } from './fixtures/store.ts'

/**
 * What every integration suite is built from: the servers, a store of its
 * own for each test, worker processes, and waiting that is bounded.
 *
 * The suites drive the built package through its exports, as the processes
 * they spawn do: build the workspace before running them.
 */

export type Target = {
  readonly name: 'PostgreSQL' | 'Redis' | 'Valkey'
  readonly kind: StoreSpec['kind']
  readonly variable: string
  readonly url: string | undefined
}

const target = (
  name: Target['name'],
  kind: Target['kind'],
  variable: string,
): Target => ({ name, kind, variable, url: process.env[variable] })

export const postgres = target('PostgreSQL', 'postgres', 'POSTGRES_URL')
export const targets: readonly Target[] = [
  postgres,
  target('Redis', 'redis', 'REDIS_URL'),
  target('Valkey', 'redis', 'VALKEY_URL'),
]

/**
 * A target without its variable is skipped, unless the run was told that
 * every server is there: a missing one is then an error, not a silent skip.
 */
export function requireServices(wanted: readonly Target[] = targets) {
  if (process.env.NMTJS_REQUIRE_SERVICE_TESTS !== '1') return
  for (const { name, variable, url } of wanted) {
    if (!url) throw new Error(`${name} integration tests require ${variable}`)
  }
}

/** A schema of its own with the tables installed, dropped with the scope. */
const schema = Effect.fnUntraced(function* (url: string) {
  const name = `workflows_it_${crypto.randomUUID().replaceAll('-', '')}`
  const context = yield* Layer.build(
    PgClient.layer({
      url: Redacted.make(url),
      startupParameters: { search_path: name },
      maxConnections: 1,
    }),
  )
  const sql = Context.get(context, SqlClient.SqlClient)
  yield* Effect.acquireRelease(sql.unsafe(`CREATE SCHEMA ${name}`), () =>
    Effect.orDie(sql.unsafe(`DROP SCHEMA ${name} CASCADE`)),
  )
  yield* Effect.provide(Postgres.install, context)
  return name
}, Effect.orDie)

/** Every key of a store's prefix, found as no store ever looks. */
export const redisKeys = Effect.fnUntraced(function* (prefix: string) {
  const redis = yield* Redis.Redis
  const found: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = yield* redis.send<[string, string[]]>(
      'SCAN',
      cursor,
      'MATCH',
      `{${prefix}}*`,
      'COUNT',
      '1000',
    )
    found.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return found
}, Effect.orDie)

/** A prefix nothing else has; its keys are deleted with the scope. */
const prefix = Effect.fnUntraced(function* (url: string) {
  const name = `workflows-it:${crypto.randomUUID()}:`
  const context = yield* Layer.build(NodeRedis.layer({ url }))
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const redis = yield* Redis.Redis
      const owned = yield* redisKeys(name)
      for (let from = 0; from < owned.length; from += 500) {
        yield* redis.send('UNLINK', ...owned.slice(from, from + 500))
      }
    }).pipe(Effect.provide(context), Effect.orDie),
  )
  return name
}, Effect.orDie)

type StoreOptions = {
  readonly maxDeliveries?: number
  /** PostgreSQL only: `false` builds stores that listen for no hints. */
  readonly hints?: boolean
}

/**
 * A place of its own on the server for one test, cleaned up with the scope:
 * a schema on PostgreSQL, a key prefix on Redis and Valkey.
 */
export const provision = (
  { kind, url }: Target,
  options: StoreOptions = {},
): Effect.Effect<StoreSpec, never, Scope.Scope> =>
  kind === 'postgres'
    ? Effect.map(schema(url!), (schema) => ({
        kind,
        url: url!,
        schema,
        ...options,
      }))
    : Effect.map(prefix(url!), (prefix) => ({
        kind,
        url: url!,
        prefix,
        ...(options.maxDeliveries === undefined
          ? {}
          : { maxDeliveries: options.maxDeliveries }),
      }))

/** Runs a test body on the real clock, with a scope that ends with it. */
export const live = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect))

/**
 * A test with a store of its own on `target`. The body's scope closes before
 * the store does, so the workers it forked stop while they still have one.
 */
export function scenario(
  target: Target,
  name: string,
  body: (
    spec: StoreSpec,
  ) => Effect.Effect<unknown, unknown, Store | Scope.Scope>,
  options: StoreOptions & { readonly timeout?: number } = {},
) {
  const { timeout = 60_000, ...store } = options
  it(
    name,
    () =>
      live(
        Effect.gen(function* () {
          const spec = yield* provision(target, store)
          const context = yield* Layer.build(storeLayer(spec))
          yield* Effect.scoped(Effect.provide(body(spec), context))
        }),
      ),
    timeout,
  )
}

/**
 * Waits until `probe` answers with something, and dies when it has not in
 * time: no test passes or fails by how long a fixed sleep happened to be.
 */
export const until = <A, E, R>(
  what: string,
  probe: Effect.Effect<A | undefined | null | false, E, R>,
  options: {
    readonly timeoutMs?: number
    readonly everyMs?: number
    /** Said with the timeout, to tell what was there instead. */
    readonly details?: () => string
  } = {},
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const { timeoutMs = 30_000, everyMs = 25, details } = options
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = yield* probe
      if (found) return found
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${what}${details ? `\n${details()}` : ''}`,
          ),
        )
      }
      yield* Effect.sleep(everyMs)
    }
  })

type Waiting = { readonly timeoutMs?: number; readonly details?: () => string }

/** The run once it is in `status`; dies when it is not in time. */
export const reached = (
  runId: string,
  status: StoredRun['status'],
  options: Waiting = {},
) => {
  let last: string | undefined
  return until(
    `run [${runId}] to be ${status}`,
    Effect.map(Client.get(runId), (records) => {
      last = records?.run.status
      return records?.run.status === status && records
    }),
    {
      ...options,
      details: () => `it is ${last}\n${options.details?.() ?? ''}`,
    },
  )
}

/** The run once it has ended, in whatever status. */
export const ended = (runId: string, options: Waiting = {}) => {
  let last: string | undefined
  return until(
    `run [${runId}] to end`,
    Effect.map(Client.get(runId), (records) => {
      last = records?.run.status
      return records && isTerminal(records.run.status) && records
    }),
    {
      ...options,
      details: () => `it is ${last}\n${options.details?.() ?? ''}`,
    },
  )
}

/**
 * Forks workers into the scope. One that fails says so: a test would
 * otherwise only time out waiting for the work it was to do.
 */
export const serve = <R>(
  ...workers: readonly Effect.Effect<never, unknown, R>[]
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.forEach(
    workers,
    (worker) =>
      Effect.forkScoped(
        Effect.tapCause(worker, (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() =>
                console.error(`A worker failed:\n${Cause.pretty(cause)}`),
              ),
        ),
      ),
    { discard: true },
  )

/** No dead command, and no command a worker still holds, for these runs. */
export const settled = Effect.fnUntraced(function* (runIds: readonly string[]) {
  const store = yield* Store
  const dead = yield* store.dead({ limit: 100 })
  const claimed = yield* store.claimed(runIds)
  return { dead: dead.items, claimed }
})

/**
 * A directory of its own for what processes leave on disk: the events their
 * handlers record, and the markers of deliveries that were held.
 */
export const workspace = Effect.gen(function* () {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'workflows-it-'))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )
  const holdDir = join(dir, 'held')
  yield* Effect.promise(() => mkdir(holdDir))
  const eventsFile = join(dir, 'events.jsonl')
  return {
    dir,
    env: { WORKFLOWS_EVENTS: eventsFile, WORKFLOWS_HOLD_DIR: holdDir },
    /** Everything recorded so far, in the order it was. */
    events: Effect.promise(async (): Promise<Recorded[]> => {
      const text = await readFile(eventsFile, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    }),
    /** Whether a delivery reached `name` and was held there. */
    held: (name: string) =>
      Effect.sync(() => existsSync(holdMarker(holdDir, name))),
  }
})

export type Workspace = Effect.Success<typeof workspace>

const workerEntry = resolve(import.meta.dirname, 'fixtures/worker.ts')

export type WorkerProcess = {
  readonly pid: number
  /** What it wrote, for the message of a failed wait. */
  readonly output: () => string
  readonly signal: (signal: NodeJS.Signals) => void
  /** How it ended, once it has. */
  readonly exited: Effect.Effect<{
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
  }>
}

/**
 * A worker process over the test's store, ready when this returns, and
 * killed with the scope if it is still there.
 */
export const spawnWorker = (
  config: WorkerConfig,
  { env }: Pick<Workspace, 'env'>,
): Effect.Effect<WorkerProcess, never, Scope.Scope> =>
  Effect.gen(function* () {
    let output = ''
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    const child: ChildProcess = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [workerEntry], {
          env: {
            ...process.env,
            ...env,
            WORKFLOWS_WORKER: JSON.stringify(config),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ),
      (child) =>
        Effect.promise(async () => {
          if (exit) return
          const gone = new Promise((resolve) => child.once('exit', resolve))
          // A stopped process takes no signal but these two.
          child.kill('SIGCONT')
          child.kill('SIGKILL')
          await gone
        }),
    )
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.on('data', (chunk) => (output += String(chunk)))
    }
    child.once('exit', (code, signal) => (exit = { code, signal }))

    const describe = () => `worker ${child.pid}:\n${output}`
    yield* until(
      `worker process ${child.pid} to be ready`,
      Effect.suspend(() =>
        exit
          ? Effect.die(
              new Error(`Worker exited before it was ready\n${describe()}`),
            )
          : Effect.succeed(output.includes('WORKFLOWS_READY')),
      ),
      { details: describe },
    )
    return {
      pid: child.pid!,
      output: describe,
      signal: (signal) => void child.kill(signal),
      exited: until(
        `worker process ${child.pid} to exit`,
        Effect.sync(() => exit),
        { details: describe },
      ),
    }
  })

export type Proxy = {
  /** The server's address, with the proxy's host and port in its place. */
  readonly url: string
  /** Drops every connection and refuses new ones, until restored. */
  readonly cut: Effect.Effect<void>
  readonly restore: Effect.Effect<void>
}

/**
 * Stands between clients and the server at `url`, so that a test can take
 * the network away and give it back. Closed with the scope.
 */
export const tcpProxy = (
  url: string,
): Effect.Effect<Proxy, never, Scope.Scope> =>
  Effect.gen(function* () {
    const upstream = new URL(url)
    const sockets = new Set<Socket>()
    let open = true
    const server = createServer((client) => {
      if (!open) return void client.destroy()
      const service = connect(Number(upstream.port), upstream.hostname)
      for (const socket of [client, service]) {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => {
          sockets.delete(socket)
          client.destroy()
          service.destroy()
        })
      }
      client.pipe(service).pipe(client)
    })
    const drop = () => {
      for (const socket of sockets) socket.destroy()
    }
    const port = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<number>((resolve) =>
            server.listen(0, '127.0.0.1', () =>
              resolve((server.address() as AddressInfo).port),
            ),
          ),
      ),
      () =>
        Effect.sync(() => {
          drop()
          server.close()
        }),
    )
    const proxied = new URL(url)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(port)
    return {
      url: proxied.toString(),
      cut: Effect.sync(() => {
        open = false
        drop()
      }),
      restore: Effect.sync(() => {
        open = true
      }),
    }
  })
