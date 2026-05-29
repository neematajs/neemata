import { appendFileSync } from 'node:fs'

import { definePluginHooks } from '@nmtjs/neem'

const pluginVersion = 'one'

export default definePluginHooks((ctx) => ({
  'server:start': () => {
    emit({
      event: 'plugin:server:start',
      name: ctx.name,
      mode: ctx.mode,
      options: ctx.options,
      version: pluginVersion,
    })
  },
  'server:ready': () => {
    emit({
      event: 'plugin:server:ready',
      name: ctx.name,
      mode: ctx.mode,
      options: ctx.options,
      version: pluginVersion,
      ready: ctx.getHealth().ready,
    })
  },
  'server:reload': () => {
    emit({
      event: 'plugin:server:reload',
      name: ctx.name,
      mode: ctx.mode,
      options: ctx.options,
      version: pluginVersion,
    })
  },
}))

function emit(event: Record<string, unknown>): void {
  const file = process.env.NEEM_PLUGIN_EVENTS_FILE
  if (!file) return
  appendFileSync(file, `${JSON.stringify(event)}\n`)
}
