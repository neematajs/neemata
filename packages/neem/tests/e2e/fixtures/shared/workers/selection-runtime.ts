import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../support/_events.ts'

export default defineRuntimeWorker<{ label: string }>({
  definition: { fixture: 'selection-runtime' },
  createRuntime(ctx) {
    const runtime = ctx.name.split(':')[0] ?? 'unknown'

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
