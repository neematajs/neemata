import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeHost((params) => {
  record({ event: 'sigterm-host-setup', mode: params.mode, name: params.name })

  return {
    start() {
      record({
        event: 'sigterm-host-start',
        mode: params.mode,
        name: params.name,
        threads: params.threads.map((thread) => thread.name),
      })
    },
    stop() {
      record({
        event: 'sigterm-host-stop',
        mode: params.mode,
        name: params.name,
        threads: params.threads.map((thread) => thread.name),
      })
    },
  }
})
