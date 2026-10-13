import { appendFileSync, existsSync } from 'node:fs'

import { NodeCrypto, NodeRuntime } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'

import { layerCatalog, layerSql } from '../../../src/native-effect/sql.ts'
import { definitions, handlers } from './app.ts'

// A standalone runner process: the same composition an application would
// write outside Neem, with `runMain` owning signals and teardown.
const { POSTGRES_URL, PREFIX, POOLS, SLOT, EVENTS_FILE, RELEASE_FILE } =
  process.env
const pools = POOLS!.split(',')
const slot = Number(SLOT)

function record(event: string) {
  return Effect.sync(() => {
    appendFileSync(EVENTS_FILE!, `${JSON.stringify({ event, slot })}\n`)
  })
}

const isReleased = Effect.sync(() => existsSync(RELEASE_FILE!))
const released = isReleased.pipe(
  Effect.repeat({
    until: (exists) => exists,
    schedule: Schedule.spaced('25 millis'),
  }),
  Effect.asVoid,
)

const registered = handlers({ record, released, isReleased })
const served = pools.map((pool) =>
  pool === 'render' ? registered.render : registered.default,
)

const runner = Layer.mergeAll(layerCatalog(definitions), ...served).pipe(
  Layer.provideMerge(
    layerSql({
      prefix: PREFIX,
      pools: ['default', 'render'],
      runner: { host: 'fixture', slot, pools },
      pollInterval: '100 millis',
      sharding: {
        shardsPerGroup: 8,
        shardLockExpiration: '3 seconds',
        shardLockRefreshInterval: '1 second',
        refreshAssignmentsInterval: '500 millis',
      },
    }),
  ),
  Layer.provide([
    PgClient.layer({ url: Redacted.make(POSTGRES_URL!), maxConnections: 6 }),
    NodeCrypto.layer,
  ]),
)

const main = Effect.gen(function* () {
  yield* record('ready')
  return yield* Effect.never
}).pipe(Effect.provide(runner))

NodeRuntime.runMain(main)
