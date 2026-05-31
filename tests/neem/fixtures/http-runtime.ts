import type { Server } from 'node:http'
import { createServer } from 'node:http'

import type { NeemWorkerRuntimeContext } from '@nmtjs/neem'
import { defineWorker } from '@nmtjs/neem'

import { record } from './_events.ts'

type HttpRuntimeData = { label: string; port: number }

export default defineWorker<HttpRuntimeData>({
  definition: { fixture: 'http-runtime' },
  createRuntime(ctx: NeemWorkerRuntimeContext<HttpRuntimeData>) {
    let server: Server | undefined

    return {
      async start() {
        record({ event: 'http-runtime-start', name: ctx.name })
        server = createServer((request, response) => {
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(
            JSON.stringify({
              runtime:
                ctx.artifact.owner.type === 'runtime'
                  ? ctx.artifact.owner.name
                  : 'config',
              thread: ctx.name,
              url: request.url,
            }),
          )
        })
        await new Promise<void>((resolveListen, reject) => {
          server?.once('error', reject)
          server?.listen(ctx.data.port, '127.0.0.1', resolveListen)
        })

        return {
          upstreams: [
            { type: 'http', url: `http://127.0.0.1:${ctx.data.port}` },
          ],
        }
      },
      async stop() {
        record({ event: 'http-runtime-stop', name: ctx.name })
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
