import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../support/_events.ts'

export type GenericRuntimeData = {
  label: string
  http?: { listen: { hostname: string; port: number } }
}

export default defineRuntimeWorker<GenericRuntimeData>({
  definition: { fixture: 'generic-runtime' },
  createRuntime(ctx: NeemRuntimeWorkerContext<GenericRuntimeData>) {
    record({
      event: 'runtime-create',
      mode: ctx.mode,
      name: ctx.name,
      data: ctx.data,
      definition: ctx.definition,
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
