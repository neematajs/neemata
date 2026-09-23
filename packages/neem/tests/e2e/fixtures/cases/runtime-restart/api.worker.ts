import { existsSync, unlinkSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

import { defineRuntimeWorker } from '@nmtjs/neem'

import { record, wait } from '../../shared/support/_events.ts'
import { definition, failStart } from './definition.ts'
import { nextGeneration } from './state.ts'

export default defineRuntimeWorker({
  definition,
  createRuntime(ctx) {
    const generation = nextGeneration()
    const { marker, upstream, startDelayMs } = ctx.definition
    const crashFile = process.env.NEEM_RESTART_CRASH_FILE
    const retiredFile = process.env.NEEM_RESTART_RETIRED_FILE
    const lazyFile = process.env.NEEM_RESTART_LAZY_FILE
    let crashTimer: NodeJS.Timeout | undefined
    let lazyTimer: NodeJS.Timeout | undefined
    return {
      async start() {
        record({
          event: 'worker-generation-start',
          name: ctx.name,
          threadId,
          generation,
          marker,
        })
        // Stands for a service the first definition used and that is gone now.
        if (retiredFile && marker === 'v1' && existsSync(retiredFile)) {
          throw new Error('The v1 dependency is retired')
        }
        if (
          failStart === 'always' ||
          (failStart === 'patched' && generation > 1)
        ) {
          throw new Error(`Worker start failed for ${marker}`)
        }
        if (startDelayMs) await wait(startDelayMs)
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
        if (lazyFile) {
          lazyTimer = setInterval(() => {
            if (!existsSync(lazyFile)) return
            clearInterval(lazyTimer)
            void import('./lazy-value.ts').then(({ lazyValue }) =>
              record({ event: 'lazy-loaded', threadId, value: lazyValue }),
            )
          }, 25)
        }
        return upstream
          ? [{ type: 'http' as const, url: 'http://127.0.0.1:12345' }]
          : undefined
      },
      stop() {
        clearInterval(crashTimer)
        clearInterval(lazyTimer)
        record({
          event: 'worker-generation-stop',
          name: ctx.name,
          threadId,
          generation,
          marker,
        })
      },
    }
  },
})
