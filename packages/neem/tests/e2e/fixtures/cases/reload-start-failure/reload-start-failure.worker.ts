import type { Server } from 'node:http'
import { createServer } from 'node:http'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

type ReloadStartFailureData = { failureDelayMs: number; port: number }

const RESPONSE_VERSION = 'good-v1'
const FAIL_ON_START = false

export default defineRuntimeWorker<ReloadStartFailureData>({
  definition: { fixture: 'reload-start-failure' },
  createRuntime(ctx) {
    let server: Server | undefined

    return {
      async start() {
        server = createServer((request, response) => {
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(
            JSON.stringify({
              runtime: ctx.name.split(':')[0] ?? 'unknown',
              thread: ctx.name,
              url: request.url,
              version: RESPONSE_VERSION,
            }),
          )
        })
        await new Promise<void>((resolveListen, reject) => {
          server?.once('error', reject)
          server?.listen(ctx.data.port, '127.0.0.1', resolveListen)
        })
        record({
          event: 'reload-start-failure-listening',
          name: ctx.name,
          port: ctx.data.port,
          version: RESPONSE_VERSION,
        })

        if (FAIL_ON_START) {
          record({
            event: 'reload-start-failure-start-failed',
            name: ctx.name,
            port: ctx.data.port,
            version: RESPONSE_VERSION,
          })
          await wait(ctx.data.failureDelayMs)
          throw new Error(
            `reload start failure fixture failed for ${RESPONSE_VERSION}`,
          )
        }

        return {
          upstreams: [
            { type: 'http', url: `http://127.0.0.1:${ctx.data.port}` },
          ],
        }
      },
      async stop() {
        record({
          event: 'reload-start-failure-stop',
          name: ctx.name,
          port: ctx.data.port,
          version: RESPONSE_VERSION,
        })
        const current = server
        server = undefined
        if (!current) return
        await new Promise<void>((resolveClose, reject) => {
          current.close((error) => {
            if (error) reject(error)
            else resolveClose()
          })
        })
      },
    }
  },
})
