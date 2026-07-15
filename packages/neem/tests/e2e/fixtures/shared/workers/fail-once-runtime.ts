import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../support/_events.ts'

export default defineRuntimeWorker<{ label: string }>({
  definition: { fixture: 'fail-once-runtime' },
  createRuntime(ctx) {
    let resolveFinished!: () => void
    let rejectFinished!: (error: Error) => void
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve
      rejectFinished = reject
    })
    void finished.catch(() => {})

    return {
      finished,
      start() {
        record({ event: 'fail-once-start', name: ctx.name })
        const marker = resolve(process.env.NEEM_FAIL_ONCE_MARKER ?? 'marker')
        if (!existsSync(marker)) {
          writeFileSync(marker, 'failed')
          setTimeout(() => {
            rejectFinished(new Error('fixture runtime failure once'))
          }, 25)
        }
      },
      stop() {
        resolveFinished()
        record({ event: 'fail-once-stop', name: ctx.name })
      },
    }
  },
})
