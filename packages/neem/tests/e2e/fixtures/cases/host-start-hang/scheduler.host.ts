import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimeHost((params) => {
  record({ event: 'host-start-hang-setup', name: params.name })

  return {
    async start() {
      record({ event: 'host-start-hang-start', name: params.name })
      await new Promise(() => {})
    },
  }
})
