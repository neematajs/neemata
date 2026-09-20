import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpServer, HttpServerResponse } from 'effect/unstable/http'

const marker = 'effect-v1'
const eventsFile = process.env.EFFECT_EVENTS_FILE!
const failureFile = process.env.EFFECT_FAILURE_FILE
const record = (event: string, url?: string) =>
  appendFileSync(eventsFile, `${JSON.stringify({ event, marker, url })}\n`)

export default defineEffectWorker(() => ({
  layer: Layer.empty,
  main: (ready) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => record('stopped')))
      const server = yield* NodeHttpServer.make(createServer, {
        host: '127.0.0.1',
        port: 0,
      })
      yield* server.serve(Effect.succeed(HttpServerResponse.text(marker)))
      const url = HttpServer.formatAddress(server.address)
      record('started', url)
      yield* ready([{ type: 'http', url }])
      if (failureFile && !existsSync(failureFile)) {
        writeFileSync(failureFile, '')
        yield* Effect.sleep('100 millis')
        return yield* Effect.fail(new Error('intentional main failure'))
      }
      yield* Effect.never
    }),
}))
