import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

export default defineRuntimeWorker({
  definition: { fixture: 'async-worker-factory' },
  async createRuntime(ctx) {
    record({ event: 'async-create-start', name: ctx.name, data: ctx.data })
    await wait(10)
    record({ event: 'async-create-ready', name: ctx.name })

    return {
      start() {
        record({ event: 'async-start', name: ctx.name })
      },
      stop() {
        record({ event: 'async-stop', name: ctx.name })
      },
    }
  },
})
