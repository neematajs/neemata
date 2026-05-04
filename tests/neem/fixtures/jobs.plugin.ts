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

  setup(ctx) {
    ctx.artifacts.list()
  },
})
