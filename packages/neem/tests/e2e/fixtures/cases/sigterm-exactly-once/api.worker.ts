import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

type SigtermData = { label: string }

export default defineRuntimeWorker<SigtermData>({
  definition: { fixture: 'sigterm-exactly-once' },
  createRuntime(ctx) {
    record({
      event: 'sigterm-runtime-create',
      label: ctx.data.label,
      mode: ctx.mode,
      name: ctx.name,
    })

    return {
      start() {
        record({
          event: 'sigterm-runtime-start',
          label: ctx.data.label,
          mode: ctx.mode,
          name: ctx.name,
        })
      },
      stop() {
        record({
          event: 'sigterm-runtime-stop',
          label: ctx.data.label,
          mode: ctx.mode,
          name: ctx.name,
        })
      },
    }
  },
})
