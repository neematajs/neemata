import { existsSync, unlinkSync } from 'node:fs'
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
    let failureTimer: ReturnType<typeof setInterval> | undefined

    return {
      finished,
      start() {
        record({ event: 'fail-once-start', name: ctx.name })
        const trigger = resolve(
          process.env.NEEM_FAIL_ONCE_TRIGGER ?? 'fail-once-trigger',
        )
        // The test requests failure after host readiness; a startup timer can
        // otherwise fail the initial start instead of exercising recovery.
        failureTimer = setInterval(() => {
          if (!existsSync(trigger)) return
          clearInterval(failureTimer)
          unlinkSync(trigger)
          rejectFinished(new Error('fixture runtime failure once'))
        }, 25)
      },
      stop() {
        clearInterval(failureTimer)
        resolveFinished()
        record({ event: 'fail-once-stop', name: ctx.name })
      },
    }
  },
})
