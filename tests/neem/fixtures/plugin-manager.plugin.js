import { definePlugin } from '@nmtjs/neem'

const eventsKey = '__neemPluginManagerEvents'

function events() {
  globalThis[eventsKey] ??= []
  return globalThis[eventsKey]
}

export default definePlugin({
  name: 'plugin-manager-fixture',
  setup(ctx) {
    events().push({
      type: 'setup',
      name: ctx.name,
      instanceId: ctx.instanceId,
      mode: ctx.mode,
      label: ctx.options?.label,
      artifact: ctx.artifacts.resolve('worker')?.id,
      workers: typeof ctx.workers.spawn,
    })

    if (ctx.options?.failSetup) {
      throw new Error(`setup failed: ${ctx.name}`)
    }
  },
  stop(ctx) {
    events().push({ type: 'stop', name: ctx.name, instanceId: ctx.instanceId })
  },
})
