import { definePluginHooks } from '@nmtjs/neem'

import { record } from './_events.ts'

export default definePluginHooks((ctx) => {
  record({ event: 'throwing-plugin-setup', name: ctx.name })

  return {
    'server:start'() {
      record({ event: 'throwing-plugin-server-start' })
      throw new Error('fixture plugin hook failure')
    },
    'host:dispose'() {
      record({ event: 'throwing-plugin-host-dispose' })
    },
  }
})
