import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from './_events.ts'

export default defineRuntimeWorker<{ label: string }>({
  definition: { fixture: 'fail-once-runtime' },
  createRuntime(ctx) {
    return {
      start() {
        record({ event: 'fail-once-start', name: ctx.name })
        const marker = resolve(process.env.NEEM_FAIL_ONCE_MARKER ?? 'marker')
        if (!existsSync(marker)) {
          writeFileSync(marker, 'failed')
          setTimeout(() => {
            throw new Error('fixture runtime failure once')
          }, 25)
        }
      },
      stop() {
        record({ event: 'fail-once-stop', name: ctx.name })
      },
    }
  },
})
