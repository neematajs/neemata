import { defineWorker } from '@nmtjs/neem'

import { record } from './_events.ts'

export default defineWorker<{ label: string }>({
  definition: { fixture: 'selection-runtime' },
  createRuntime(ctx) {
    const runtime =
      ctx.artifact.owner.type === 'runtime' ? ctx.artifact.owner.name : 'config'

    return {
      start() {
        record({
          event: 'selection-start',
          runtime,
          name: ctx.name,
          data: ctx.data,
        })
      },
      stop() {
        record({ event: 'selection-stop', runtime, name: ctx.name })
      },
    }
  },
})
