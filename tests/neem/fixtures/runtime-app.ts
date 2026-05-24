import { appendFileSync } from 'node:fs'

import type { NeemWorkerRuntimeContext } from '@nmtjs/neem'
import { defineWorker } from '@nmtjs/neem'

export type RuntimeAppThreadOptions = {
  http: { listen: { hostname: string; port: number } }
  label: string
  fail?: 'start' | 'runtime'
  startDelayMs?: number
  runtimeFailDelayMs?: number
}

type RuntimeAppDefinition = { fixture: 'runtime-app' }

function record(event: Record<string, unknown>) {
  const file = process.env.NEEM_RUNTIME_EVENTS_FILE
  if (!file) return
  appendFileSync(file, `${JSON.stringify(event)}\n`)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default defineWorker<RuntimeAppThreadOptions, RuntimeAppDefinition>({
  definition: { fixture: 'runtime-app' },
  createRuntime(
    ctx: NeemWorkerRuntimeContext<
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
      artifact: ctx.artifact,
      artifacts: ctx.artifacts.list(),
      logger: Boolean(ctx.logger),
    })

    return {
      async start() {
        if (ctx.data.startDelayMs) {
          await wait(ctx.data.startDelayMs)
        }

        record({ event: 'start', name: ctx.name })

        if (ctx.data.fail === 'start') {
          throw new Error(`fixture start failure ${ctx.name}`)
        }

        if (ctx.data.fail === 'runtime') {
          setTimeout(() => {
            throw new Error(`fixture runtime failure ${ctx.name}`)
          }, ctx.data.runtimeFailDelayMs ?? 25)
        }

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
