import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeHost((params) => {
  record({
    event: 'file-url-host-setup',
    name: params.name,
    options: params.options,
    threads: params.threads.map((thread) => thread.name),
  })

  return {
    start() {
      record({
        event: 'file-url-host-start',
        name: params.name,
        options: params.options,
        threads: params.threads.map((thread) => thread.name),
      })
    },
    stop() {
      record({
        event: 'file-url-host-stop',
        name: params.name,
        threads: params.threads.map((thread) => thread.name),
      })
    },
  }
})
