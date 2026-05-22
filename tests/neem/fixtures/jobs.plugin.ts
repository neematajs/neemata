import { definePlugin } from '@nmtjs/neem'

export type JobsPluginOptions = {
  queue: string
  concurrency?: number
  observeHooks?: boolean
}

export default definePlugin<JobsPluginOptions>({
  name: 'jobs',

  artifacts() {
    return [
      {
        id: 'job-worker',
        kind: 'worker',
        entry: new URL('./jobs.worker.ts', import.meta.url),
      },
      {
        id: 'job-renderer',
        kind: 'module',
        entry: new URL('./jobs.renderer.ts', import.meta.url),
      },
    ]
  },

  async setup(ctx) {
    ctx.artifacts.list()
    if (ctx.options.observeHooks) {
      ctx.hooks.addHooks({
        server: {
          start: (event) =>
            writeEvent({ event: 'host-server-start', mode: event.mode }),
          ready: (event) =>
            writeEvent({ event: 'host-server-ready', mode: event.mode }),
          stop: (event) =>
            writeEvent({ event: 'host-server-stop', mode: event.mode }),
        },
        app: {
          start: (event) =>
            writeEvent({
              event: 'host-app-start',
              mode: event.mode,
              appName: event.appName,
            }),
          ready: (event) =>
            writeEvent({
              event: 'host-app-ready',
              mode: event.mode,
              appName: event.appName,
            }),
          stop: (event) =>
            writeEvent({
              event: 'host-app-stop',
              mode: event.mode,
              appName: event.appName,
            }),
        },
        worker: {
          start: (event) =>
            writeEvent({
              event: 'host-worker-start',
              mode: event.mode,
              worker: event.name,
              owner: event.owner,
            }),
          ready: (event) =>
            writeEvent({
              event: 'host-worker-ready',
              mode: event.mode,
              worker: event.name,
              owner: event.owner,
            }),
          stop: (event) =>
            writeEvent({
              event: 'host-worker-stop',
              mode: event.mode,
              worker: event.name,
              owner: event.owner,
            }),
        },
      })
    }
    await writeEvent({
      event: 'plugin-setup',
      mode: ctx.mode,
      name: ctx.name,
      instanceId: ctx.instanceId,
      options: ctx.options,
      logger: Boolean(ctx.logger),
      artifacts: ctx.artifacts
        .list()
        .map((artifact) => ({ id: artifact.id, owner: artifact.owner })),
    })
  },

  async stop(ctx) {
    await writeEvent({
      event: 'plugin-stop',
      mode: ctx.mode,
      name: ctx.name,
      instanceId: ctx.instanceId,
    })
  },
})

async function writeEvent(event: Record<string, unknown>) {
  const file = process.env.NEEM_RUNTIME_EVENTS_FILE
  if (!file) return
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, `${JSON.stringify(event)}\n`)
}
