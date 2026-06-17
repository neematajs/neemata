import type { Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

type RecoveryHealthData = {
  attempt: number
  marker: string
  port: number
  recoveryDelayMs: number
}

export default defineRuntimeWorker<RecoveryHealthData>({
  definition: { fixture: 'recovery-health' },
  createRuntime(ctx) {
    let server: Server | undefined

    return {
      async start() {
        writeFileSync(ctx.data.marker, String(ctx.data.attempt))
        if (ctx.data.attempt === 2) {
          record({
            event: 'recovery-health-delay',
            attempt: ctx.data.attempt,
            name: ctx.name,
            port: ctx.data.port,
          })
          await wait(ctx.data.recoveryDelayMs)
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
              throw new Error('recovery health fixture worker crash')
            }, 25)
          }
        })
        await new Promise<void>((resolveListen, reject) => {
          server?.once('error', reject)
          server?.listen(ctx.data.port, '127.0.0.1', resolveListen)
        })
        record({
          event: 'recovery-health-start',
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
          event: 'recovery-health-stop',
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
