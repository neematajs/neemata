import { definePluginHooks } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default definePluginHooks((ctx) => {
  record({ event: 'sigterm-plugin-setup', name: ctx.name })

  return {
    initialize(event) {
      record({ event: 'sigterm-plugin-initialize', mode: event.mode })
    },
    dispose(event) {
      record({ event: 'sigterm-plugin-dispose', mode: event.mode })
    },
  }
})
