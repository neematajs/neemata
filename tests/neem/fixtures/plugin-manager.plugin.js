import { definePlugin } from '@nmtjs/neem'

const eventsKey = '__neemPluginManagerEvents'

function events() {
  globalThis[eventsKey] ??= []
  return globalThis[eventsKey]
}

export default definePlugin({
  name: 'plugin-manager-fixture',
  async setup(ctx) {
    events().push({
      type: 'setup',
      name: ctx.name,
      instanceId: ctx.instanceId,
      mode: ctx.mode,
      label: ctx.options?.label,
      artifact: ctx.artifacts.resolve('worker')?.id,
      workers: typeof ctx.workers.spawn,
      hooks: typeof ctx.hooks.addHooks,
    })

    if (ctx.options?.observeHooks) {
      ctx.hooks.addHooks({
        plugin: {
          ready(event) {
            events().push({
              type: 'hook-plugin-ready',
              name: event.name,
              instanceId: event.instanceId,
            })
            if (ctx.options?.failHook) {
              throw new Error(`hook failed: ${event.name}`)
            }
          },
          stop(event) {
            events().push({
              type: 'hook-plugin-stop',
              name: event.name,
              instanceId: event.instanceId,
            })
          },
        },
      })
    }

    if (ctx.options?.failSetup) {
      throw new Error(`setup failed: ${ctx.name}`)
    }

    if (ctx.options?.spawnWorker) {
      await ctx.workers.spawn({
        name: `${ctx.name}-worker`,
        artifact: 'worker',
        workerData: ctx.options.workerData ?? {},
      })
      events().push({
        type: 'worker-spawned',
        name: ctx.name,
        instanceId: ctx.instanceId,
      })
    }
  },
  stop(ctx) {
    events().push({ type: 'stop', name: ctx.name, instanceId: ctx.instanceId })
    if (ctx.options?.failStop) {
      throw new Error(`stop failed: ${ctx.name}`)
    }
  },
})
