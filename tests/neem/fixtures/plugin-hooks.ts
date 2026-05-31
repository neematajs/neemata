import { definePluginHooks } from '@nmtjs/neem'

import { record } from './_events.ts'

export default definePluginHooks((ctx) => {
  record({
    event: 'plugin-setup',
    name: ctx.name,
    mode: ctx.mode,
    options: ctx.options,
  })

  return {
    'host:initialize'(event) {
      record({ event: 'plugin-host-initialize', mode: event.mode })
    },
    'server:start'(event) {
      record({ event: 'plugin-server-start', mode: event.mode })
    },
    'runtime:start'(event) {
      record({ event: 'plugin-runtime-start', name: event.name })
    },
    'runtime:ready'(event) {
      record({
        event: 'plugin-runtime-ready',
        name: event.name,
        upstreams: event.upstreams?.length ?? 0,
      })
    },
    'runtime:fail'(event) {
      record({
        event: 'plugin-runtime-fail',
        name: event.name,
        message: event.error?.message,
      })
    },
    'host:dispose'(event) {
      record({ event: 'plugin-host-dispose', mode: event.mode })
    },
  }
})
