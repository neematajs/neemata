import { existsSync, unlinkSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'
import { hmrValue } from './hmr-value.ts'
import { nextGeneration } from './state.ts'

export default defineRuntimeWorker({
  definition: hmrValue,
  createRuntime(ctx) {
    const generation = nextGeneration()
    const { marker, upstream } = ctx.definition
    const crashFile = process.env.NEEM_HMR_CRASH_FILE
    let crashTimer: NodeJS.Timeout | undefined
    return {
      start() {
        record({
          event: 'worker-hmr-start',
          name: ctx.name,
          threadId,
          generation,
          marker,
        })
        // One thread consumes the signal; host recovery restarts the pool.
        if (crashFile) {
          crashTimer = setInterval(() => {
            if (!existsSync(crashFile)) return
            try {
              unlinkSync(crashFile)
            } catch {
              return
            }
            process.exit(1)
          }, 25)
        }
        return upstream
          ? [{ type: 'http' as const, url: 'http://127.0.0.1:12345' }]
          : undefined
      },
      stop() {
        clearInterval(crashTimer)
        record({
          event: 'worker-hmr-stop',
          name: ctx.name,
          threadId,
          generation,
          marker,
        })
      },
    }
  },
})
