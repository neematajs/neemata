import { appendFileSync } from 'node:fs'

import type { NeemAppRuntimeContext } from '@nmtjs/neem'
import { defineApp } from '@nmtjs/neem'

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

export default defineApp<RuntimeAppThreadOptions, RuntimeAppDefinition>({
  kind: 'runtime-fixture',
  definition: { fixture: 'runtime-app' },
  createRuntime(
    ctx: NeemAppRuntimeContext<RuntimeAppThreadOptions, RuntimeAppDefinition>,
  ) {
    record({
      event: 'create',
      mode: ctx.mode,
      appName: ctx.appName,
      threadIndex: ctx.threadIndex,
      threadOptions: ctx.threadOptions,
      artifact: ctx.artifact,
      artifacts: ctx.artifacts.list(),
    })

    return {
      async start() {
        if (ctx.threadOptions.startDelayMs) {
          await wait(ctx.threadOptions.startDelayMs)
        }

        record({
          event: 'start',
          appName: ctx.appName,
          threadIndex: ctx.threadIndex,
        })

        if (ctx.threadOptions.fail === 'start') {
          throw new Error(`fixture start failure ${ctx.threadIndex}`)
        }

        if (ctx.threadOptions.fail === 'runtime') {
          setTimeout(() => {
            throw new Error(`fixture runtime failure ${ctx.threadIndex}`)
          }, ctx.threadOptions.runtimeFailDelayMs ?? 25)
        }

        const { hostname, port } = ctx.threadOptions.http.listen
        return [
          {
            type: 'http',
            url: `http://${hostname}:${port}/${ctx.appName}/${ctx.threadIndex}`,
          },
        ]
      },
      stop() {
        record({
          event: 'stop',
          appName: ctx.appName,
          threadIndex: ctx.threadIndex,
        })
      },
    }
  },
})
