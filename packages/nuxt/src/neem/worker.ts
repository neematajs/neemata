import { defineRuntimeWorker } from '@nmtjs/neem'
import createImpl from 'neem-nuxt:impl'
import options from 'neem-nuxt:options'

import type { NeemNuxtBakedOptions } from '../types.ts'

export default defineRuntimeWorker<unknown, NeemNuxtBakedOptions>({
  definition: options,
  createRuntime(ctx) {
    return createImpl(ctx, options)
  },
})
