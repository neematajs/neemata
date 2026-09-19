import { defineRuntimeWorker } from '@nmtjs/neem'
import createImpl from 'neem-vite:impl'
import options from 'neem-vite:options'

import type { NeemViteBakedOptions } from '../types.ts'

export default defineRuntimeWorker<unknown, NeemViteBakedOptions>({
  definition: options,
  createRuntime(ctx) {
    return createImpl(ctx, options)
  },
})
