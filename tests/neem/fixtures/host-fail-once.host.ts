import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from './_events.ts'

export default defineRuntimeHost((params) => {
  record({ event: 'host-fail-once-setup', name: params.name })

  return {
    start() {
      record({ event: 'host-fail-once-start', name: params.name })
      const marker = resolve(
        process.env.NEEM_HOST_FAIL_ONCE_MARKER ?? 'host-marker',
      )
      if (!existsSync(marker)) {
        writeFileSync(marker, 'failed')
        setTimeout(() => {
          throw new Error('fixture host failure once')
        }, 25)
      }
    },
    stop() {
      record({ event: 'host-fail-once-stop', name: params.name })
    },
  }
})
