import { threadId } from 'node:worker_threads'

import { NodeCrypto } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { call, step } from '@nmtjs/workflows/native-effect'
import { defineNativeWorkflowsWorker } from '@nmtjs/workflows/native-effect/neem'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { DurableDeferred } from 'effect/workflow'

import { Approval, definitions, Invoice, Render } from './app.ts'

// Each step reports the thread it ran on, which is how the test tells the
// two pools apart.
const handlers = {
  default: Invoice.toLayer(({ invoice }) =>
    Effect.gen(function* () {
      const prepared = yield* step({
        name: 'prepare',
        success: Schema.Number,
        execute: Effect.succeed(threadId),
      })
      yield* DurableDeferred.await(Approval)
      const rendered = yield* call('receipt', Render, { invoice })
      return { prepared, rendered }
    }),
  ),
  render: Render.toLayer(() =>
    step({
      name: 'render',
      success: Schema.Number,
      execute: Effect.succeed(threadId),
    }),
  ),
}

export default defineNativeWorkflowsWorker({
  definitions,
  handlers: (pool) => (pool === 'render' ? handlers.render : handlers.default),
  layer: () =>
    Layer.mergeAll(
      PgClient.layer({
        url: Redacted.make(process.env.POSTGRES_URL!),
        maxConnections: 4,
      }),
      NodeCrypto.layer,
    ),
  engine: {
    prefix: process.env.NATIVE_PREFIX,
    pollInterval: '100 millis',
    sharding: { shardsPerGroup: 8 },
  },
})
