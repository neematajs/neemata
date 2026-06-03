import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeHost((params) => {
  record({
    event: 'host-setup',
    mode: params.mode,
    name: params.name,
    options: params.options,
    logger: Boolean(params.logger),
  })

  return {
    start() {
      record({
        event: 'host-start',
        threads: params.threads.map((thread) => thread.name),
      })
      for (const thread of params.threads) {
        thread.port.postMessage({ type: 'host-ready', thread: thread.name })
      }
    },
    stop() {
      record({
        event: 'host-stop',
        threads: params.threads.map((thread) => thread.name),
      })
    },
  }
})
