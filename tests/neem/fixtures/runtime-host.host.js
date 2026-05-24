import { appendFile } from 'node:fs/promises'

async function record(file, event) {
  await appendFile(file, `${event}\n`)
}

export default {
  async setup(ctx) {
    await record(ctx.options.eventFile, `host-setup:${ctx.name}`)
  },
  async plan(ctx) {
    await record(ctx.options.eventFile, `host-plan:${ctx.name}`)
    if (ctx.options.failPlan) {
      throw new Error('host plan failed')
    }
    return {
      threads: [
        {
          name: `${ctx.name}:worker`,
          artifact: ctx.options.useResolvedArtifact
            ? ctx.artifacts.resolve('entry')
            : 'entry',
          data: {
            eventFile: ctx.options.eventFile,
            upstreamUrl: ctx.options.upstreamUrl,
            failAfterStart: ctx.options.failWorkerAfterStart,
          },
        },
      ],
    }
  },
  async start(ctx) {
    await record(
      ctx.options.eventFile,
      `host-start:${ctx.threads.length}:${ctx.upstreams.length}`,
    )
    if (ctx.options.failStart) {
      throw new Error('host start failed')
    }
  },
  async stop(ctx) {
    await record(ctx.options.eventFile, `host-stop:${ctx.threads.length}`)
    if (ctx.options.failStop) {
      throw new Error('host stop failed')
    }
  },
  async fail(ctx) {
    await record(ctx.options.eventFile, `host-fail:${ctx.threads.length}`)
    if (ctx.options.failFail) {
      throw new Error('host fail failed')
    }
  },
}
