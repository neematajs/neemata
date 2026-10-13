import { randomBytes } from 'node:crypto'
import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'

import { NodeCrypto } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Redacted from 'effect/Redacted'
import pg from 'pg'
import { expect, it } from 'vitest'

import {
  runNeem,
  spawnNode,
  waitFor as waitForOutput,
} from '../../../neem/tests/e2e/support/e2e.ts'
import { createTempDir } from '../../../neem/tests/support/temp.ts'
import { signal, start } from '../../src/native-effect/index.ts'
import { layerSql } from '../../src/native-effect/sql.ts'
import { Approval, Invoice } from '../fixtures/native-effect-neem/app.ts'
import { waitFor } from '../support/native-effect.ts'

const url = process.env.POSTGRES_URL
if (!url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
  throw new Error('Native Effect integration tests require POSTGRES_URL')
}

it.skipIf(!url)(
  'hosts one runner per pool thread under Neem and stops cleanly',
  async () => {
    const prefix = `nmtjs_native_${randomBytes(4).toString('hex')}`
    const dir = await createTempDir(
      'native-effect-neem-',
      resolve(import.meta.dirname, '../.tmp'),
    )
    const fixture = resolve(dir, 'fixture')
    const outDir = resolve(dir, '.neem')
    await cp(
      resolve(import.meta.dirname, '../fixtures/native-effect-neem'),
      fixture,
      { recursive: true },
    )
    await runNeem([
      'build',
      '--config',
      resolve(fixture, 'neem.config.ts'),
      '--outDir',
      outDir,
    ])

    const neem = spawnNode([resolve(outDir, 'start.js')], {
      env: { POSTGRES_URL: url, NATIVE_PREFIX: prefix },
    })
    const output = () => `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`
    const client = ManagedRuntime.make(
      layerSql({
        prefix,
        pools: ['default', 'render'],
        sharding: { shardsPerGroup: 8 },
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            PgClient.layer({ url: Redacted.make(url!), maxConnections: 3 }),
            NodeCrypto.layer,
          ),
        ),
      ),
    )

    try {
      await waitForOutput(
        () => neem.stdout().includes('NEEM_SERVER_READY\n'),
        30_000,
        output,
      )

      const done = await client.runPromise(
        Effect.gen(function* () {
          const id = yield* start(Invoice, { invoice: '254' })
          yield* waitFor(Invoice, id, 'Suspended', '30 seconds')
          yield* signal(Invoice, id, Approval, Exit.succeed(true))
          return yield* waitFor(Invoice, id, 'Succeeded', '30 seconds')
        }),
      )

      // Both steps ran in worker threads, and the task in a different one.
      const { prepared, rendered } = done.value
      expect(prepared).toBeGreaterThan(0)
      expect(rendered).toBeGreaterThan(0)
      expect(rendered).not.toBe(prepared)

      // Neem's default stop budget is 15 seconds; a kill would fail the exit.
      const stopping = Date.now()
      const exit = await neem.stop({ killAfterMs: 15_000 })
      expect(exit, output()).toEqual({ code: 0, signal: null })
      expect(Date.now() - stopping).toBeLessThan(15_000)
    } finally {
      await neem.stop({ killAfterMs: 2_000 }).catch(() => {})
      await client.dispose()

      const admin = new pg.Client({ connectionString: url })
      await admin.connect()
      const { rows } = await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE tablename LIKE $1`,
        [`${prefix}%`],
      )
      for (const { tablename } of rows) {
        await admin.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`)
      }
      await admin.end()
    }
  },
  120_000,
)
