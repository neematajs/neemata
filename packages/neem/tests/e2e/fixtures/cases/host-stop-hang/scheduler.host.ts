import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeHost((params) => {
  record({ event: 'host-stop-hang-setup', name: params.name })

  return {
    start() {
      record({ event: 'host-stop-hang-start', name: params.name })
    },
    async stop() {
      record({ event: 'host-stop-hang-stop', name: params.name })
      await new Promise(() => {})
    },
  }
})
