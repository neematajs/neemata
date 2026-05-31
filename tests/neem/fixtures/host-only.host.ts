import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from './_events.ts'

export default defineRuntimeHost((params) => {
  record({
    event: 'host-only-setup',
    mode: params.mode,
    name: params.name,
    options: params.options,
    defaultThreads: params.defaultThreads.length,
  })

  return {
    start(startParams) {
      record({
        event: 'host-only-start',
        threads: startParams.threads.length,
        upstreams: startParams.upstreams.length,
      })
    },
    stop(stopParams) {
      record({ event: 'host-only-stop', threads: stopParams.threads.length })
    },
  }
})
