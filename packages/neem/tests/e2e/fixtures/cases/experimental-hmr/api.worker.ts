import { defineRuntimeWorker } from '@nmtjs/neem'

import { hmrValue } from './hmr-value.ts'
import { ExperimentalHmrRuntime } from './runtime.ts'

type WorkerData = { label: string }
type Definition = typeof hmrValue

export default defineRuntimeWorker<WorkerData, Definition>({
  definition: hmrValue,
  createRuntime(ctx) {
    return new ExperimentalHmrRuntime(ctx)
  },
  ...((import.meta as ImportMeta & { readonly hot?: unknown }).hot
    ? {
        async hmr() {
          const { experimentalHmrAdapter } = await import('./hmr.ts')
          return experimentalHmrAdapter
        },
      }
    : {}),
})
