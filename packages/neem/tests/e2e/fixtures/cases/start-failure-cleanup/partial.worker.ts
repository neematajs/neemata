import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'

type PartialStartupData = {
  fail?: boolean
  label: string
  startDelayMs?: number
}

export default defineRuntimeWorker<PartialStartupData>({
  definition: { fixture: 'start-failure-cleanup' },
  createRuntime(ctx) {
    record({ event: 'partial-create', label: ctx.data.label, name: ctx.name })

    return {
      async start() {
        if (ctx.data.startDelayMs) await wait(ctx.data.startDelayMs)
        record({
          event: 'partial-start',
          label: ctx.data.label,
          name: ctx.name,
        })

        if (ctx.data.fail)
          throw new Error(`partial startup failure ${ctx.name}`)
      },
      stop() {
        record({ event: 'partial-stop', label: ctx.data.label, name: ctx.name })
      },
    }
  },
})
