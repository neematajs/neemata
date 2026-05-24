import { appendFileSync } from 'node:fs'

import { defineRuntimeHost } from '@nmtjs/neem'

function record(event: Record<string, unknown>) {
  const file = process.env.NEEM_RUNTIME_EVENTS_FILE
  if (!file) return
  appendFileSync(file, `${JSON.stringify(event)}\n`)
}

export default defineRuntimeHost({
  setup(ctx) {
    record({
      event: 'host-setup',
      mode: ctx.mode,
      name: ctx.name,
      options: ctx.options,
      artifact: ctx.artifact,
      hostArtifact: ctx.hostArtifact,
      logger: Boolean(ctx.logger),
    })
  },
  plan() {
    record({ event: 'host-plan' })
    return {
      threads: [
        {
          name: 'worker',
          artifact: 'entry',
          count: 2,
          data: { label: 'planned' },
        },
      ],
    }
  },
  start(ctx) {
    record({
      event: 'host-start',
      threads: ctx.threads.map((thread) => thread.name),
      upstreams: ctx.upstreams,
    })
    for (const thread of ctx.threads) {
      thread.port.postMessage({ type: 'host-ready', thread: thread.name })
    }
  },
  stop(ctx) {
    record({
      event: 'host-stop',
      threads: ctx.threads.map((thread) => thread.name),
    })
  },
})
