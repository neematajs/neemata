import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'
import { hmrValue } from './hmr-value.ts'

type Definition = typeof hmrValue

export default defineRuntimeWorker<{ label: string }, Definition>({
  definition: hmrValue,
  createRuntime(ctx: NeemRuntimeWorkerContext<{ label: string }, Definition>) {
    return {
      start() {
        record({
          event: 'experimental-hmr-start',
          marker: ctx.definition.marker,
          name: ctx.name,
        })
      },
      reload(next) {
        if (next.reject) throw new Error(`rejected ${next.marker}`)
        record({
          event: 'experimental-hmr-applied',
          marker: next.marker,
          name: ctx.name,
        })
      },
      stop() {
        record({ event: 'experimental-hmr-stop', name: ctx.name })
      },
    }
  },
})
