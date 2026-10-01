import { parentPort } from 'node:worker_threads'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

export default defineRuntimeWorker({
  definition: undefined,
  async createRuntime(ctx) {
    record({ event: 'startup-create', name: ctx.name })
    // Holding creation until the thread's stop request arrives keeps the stop
    // inside the factory, however late the test sends it.
    if (process.env.NEEM_STARTUP_PHASE === 'factory') await untilStopRequested()
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

function untilStopRequested(): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (message: { type?: unknown } | undefined) => {
      if (message?.type !== 'stop') return
      parentPort?.off('message', onMessage)
      resolve()
    }
    parentPort?.on('message', onMessage)
  })
}
