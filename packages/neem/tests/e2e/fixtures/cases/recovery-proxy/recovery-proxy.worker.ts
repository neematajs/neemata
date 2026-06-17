import type { Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

type RecoveryProxyData = { attempt: number; marker: string; port: number }

export default defineRuntimeWorker<RecoveryProxyData>({
  definition: { fixture: 'recovery-proxy' },
  createRuntime(ctx) {
    let server: Server | undefined

    return {
      async start() {
        writeFileSync(ctx.data.marker, String(ctx.data.attempt))
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

        return {
          upstreams: [
            { type: 'http', url: `http://127.0.0.1:${ctx.data.port}` },
          ],
        }
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
