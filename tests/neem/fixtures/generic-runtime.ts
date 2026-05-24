import { appendFileSync } from 'node:fs'

import type { NeemWorkerRuntimeContext } from '@nmtjs/neem'
import { defineWorker } from '@nmtjs/neem'

export type GenericRuntimeData = {
  label: string
  http?: { listen: { hostname: string; port: number } }
}

function record(event: Record<string, unknown>) {
  const file = process.env.NEEM_RUNTIME_EVENTS_FILE
  if (!file) return
  appendFileSync(file, `${JSON.stringify(event)}\n`)
}

export default defineWorker<GenericRuntimeData>({
  definition: { fixture: 'generic-runtime' },
  createRuntime(ctx: NeemWorkerRuntimeContext<GenericRuntimeData>) {
    record({
      event: 'runtime-create',
      mode: ctx.mode,
      name: ctx.name,
      data: ctx.data,
      definition: ctx.definition,
      artifact: ctx.artifact,
      logger: Boolean(ctx.logger),
    })

    ctx.port.on('message', (message) => {
      record({ event: 'runtime-message', name: ctx.name, message })
    })

    return {
      start() {
        record({ event: 'runtime-start', name: ctx.name })

        if (!ctx.data.http) return

        const { hostname, port } = ctx.data.http.listen
        return {
          upstreams: [
            { type: 'http', url: `http://${hostname}:${port}/${ctx.name}` },
          ],
        }
      },
      stop() {
        record({ event: 'runtime-stop', name: ctx.name })
      },
    }
  },
})
