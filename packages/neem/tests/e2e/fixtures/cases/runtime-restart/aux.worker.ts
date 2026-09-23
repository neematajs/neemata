import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeWorker<{ label: string }>({
  definition: {},
  createRuntime(ctx) {
    return {
      start() {
        record({ event: 'aux-start', label: ctx.data.label })
        return undefined
      },
      stop() {},
    }
  },
})
