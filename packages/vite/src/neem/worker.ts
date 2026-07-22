import { defineRuntimeWorker } from '@nmtjs/neem'
import createViteRuntime from 'neem-vite:impl'
import options from 'neem-vite:options'

import type { NeemViteBakedOptions } from '../types.ts'

export default defineRuntimeWorker<unknown, NeemViteBakedOptions>({
  definition: options,
  createRuntime(ctx) {
    return createViteRuntime(ctx, options)
  },
})
