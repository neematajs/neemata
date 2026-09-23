import type { Server } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

type RecoveryProxyData = {
  attempt: number
  marker: string
  port: number
  release: string
}

// Bounded below Neem's 30 s worker startup deadline so a test that never
// releases fails on its own assertions instead of hanging.
const RELEASE_TIMEOUT_MS = 20_000

export default defineRuntimeWorker<RecoveryProxyData>({
  definition: { fixture: 'recovery-proxy' },
  createRuntime(ctx) {
    let server: Server | undefined

    return {
      async start() {
        writeFileSync(ctx.data.marker, String(ctx.data.attempt))
        if (ctx.data.attempt === 2) {
          record({
            event: 'recovery-proxy-delay',
            attempt: ctx.data.attempt,
            name: ctx.name,
            port: ctx.data.port,
          })
          const deadline = Date.now() + RELEASE_TIMEOUT_MS
          while (!existsSync(ctx.data.release) && Date.now() < deadline) {
            await wait(25)
          }
        }

        server = createServer((request, response) => {
          const crashing = request.url?.includes('/crash') ?? false
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(
            JSON.stringify({
              attempt: ctx.data.attempt,
              crashing,
              port: ctx.data.port,
              runtime: ctx.name.split(':')[0] ?? 'unknown',
              thread: ctx.name,
              url: request.url,
            }),
          )

          if (crashing) {
            setTimeout(() => {
              throw new Error('recovery proxy fixture worker crash')
            }, 25)
          }
        })
        await new Promise<void>((resolveListen, reject) => {
          server?.once('error', reject)
          server?.listen(ctx.data.port, '127.0.0.1', resolveListen)
        })
        record({
          event: 'recovery-proxy-start',
          attempt: ctx.data.attempt,
          name: ctx.name,
          port: ctx.data.port,
        })

        return [
          { type: 'http' as const, url: `http://127.0.0.1:${ctx.data.port}` },
        ]
      },
      async stop() {
        record({
          event: 'recovery-proxy-stop',
          attempt: ctx.data.attempt,
          name: ctx.name,
          port: ctx.data.port,
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
