import { definePlugin } from '@nmtjs/neem/plugin'

export type JobsPluginOptions = { queue: string; concurrency?: number }

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
    await writeEvent({
      event: 'plugin-setup',
      mode: ctx.mode,
      name: ctx.name,
      instanceId: ctx.instanceId,
      options: ctx.options,
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
