import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../support/_events.ts'

export type RuntimeAppThreadOptions = {
  http?: { listen: { hostname: string; port: number } }
  label: string
  fail?: 'start' | 'runtime'
  startDelayMs?: number
  runtimeFailDelayMs?: number
}

type RuntimeAppDefinition = { fixture: 'runtime-app' }

export default defineRuntimeWorker<
  RuntimeAppThreadOptions,
  RuntimeAppDefinition
>({
  definition: { fixture: 'runtime-app' },
  createRuntime(
    ctx: NeemRuntimeWorkerContext<
      RuntimeAppThreadOptions,
      RuntimeAppDefinition
    >,
  ) {
    record({
      event: 'create',
      mode: ctx.mode,
      name: ctx.name,
      data: ctx.data,
      definition: ctx.definition,
      logger: Boolean(ctx.logger),
    })

    return {
      async start() {
        if (ctx.data.startDelayMs) await wait(ctx.data.startDelayMs)
        record({ event: 'start', name: ctx.name })

        if (ctx.data.fail === 'start') {
          throw new Error(`fixture start failure ${ctx.name}`)
        }

        if (ctx.data.fail === 'runtime') {
          setTimeout(() => {
            throw new Error(`fixture runtime failure ${ctx.name}`)
          }, ctx.data.runtimeFailDelayMs ?? 25)
        }

        if (!ctx.data.http) return
        const { hostname, port } = ctx.data.http.listen
        return {
          upstreams: [
            { type: 'http', url: `http://${hostname}:${port}/${ctx.name}` },
          ],
        }
      },
      stop() {
        record({ event: 'stop', name: ctx.name })
      },
    }
  },
})
