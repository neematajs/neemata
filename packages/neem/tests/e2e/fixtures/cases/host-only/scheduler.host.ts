import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeHost((params) => {
  record({
    event: 'host-only-setup',
    mode: params.mode,
    name: params.name,
    options: params.options,
  })

  return {
    start() {
      record({ event: 'host-only-start', threads: params.threads.length })
    },
    stop() {
      record({ event: 'host-only-stop', threads: params.threads.length })
    },
  }
})
