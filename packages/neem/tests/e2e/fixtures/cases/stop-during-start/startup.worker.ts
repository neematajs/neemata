import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

export default defineRuntimeWorker({
  definition: undefined,
  async createRuntime(ctx) {
    record({ event: 'startup-create', name: ctx.name })
    if (process.env.NEEM_STARTUP_PHASE === 'factory') await wait(300)
    const ready = Promise.withResolvers<undefined>()
    void ready.promise.catch(() => {})
    return {
      start() {
        record({ event: 'startup-entered', name: ctx.name })
        return ready.promise
      },
      async stop() {
        record({ event: 'startup-stop', name: ctx.name })
        ready.reject(new Error('startup interrupted'))
        // Cleanup is asynchronous; rejecting start must not kill its thread.
        await wait(75)
        record({ event: 'startup-finalized', name: ctx.name })
      },
    }
  },
})
