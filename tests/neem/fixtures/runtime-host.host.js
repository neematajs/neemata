import { appendFile } from 'node:fs/promises'

async function record(file, event) {
  await appendFile(file, `${event}\n`)
}

const workerFailures = new Map()

export default {
  async setup(ctx) {
    await record(ctx.options.eventFile, `host-setup:${ctx.name}`)
  },
  async plan(ctx) {
    await record(ctx.options.eventFile, `host-plan:${ctx.name}`)
    if (ctx.options.failPlan) {
      throw new Error('host plan failed')
    }
    const threads = [
      {
        name: `${ctx.name}:worker`,
        artifact: ctx.options.useResolvedArtifact
          ? ctx.artifacts.resolve('entry')
          : 'entry',
        data: {
          eventFile: ctx.options.eventFile,
          upstreamUrl: ctx.options.upstreamUrl,
          failAfterStart: shouldFailWorkerAfterStart(ctx),
        },
      },
    ]
    if (ctx.options.extraStableWorker) {
      threads.push({
        name: `${ctx.name}:stable`,
        artifact: ctx.options.useResolvedArtifact
          ? ctx.artifacts.resolve('entry')
          : 'entry',
        data: {
          eventFile: ctx.options.eventFile,
          upstreamUrl: ctx.options.upstreamUrl,
          failAfterStart: false,
        },
      })
    }
    return { threads }
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

function shouldFailWorkerAfterStart(ctx) {
  const option = ctx.options.failWorkerAfterStart
  if (typeof option !== 'number') return Boolean(option)

  const key = `${ctx.options.eventFile}:${ctx.name}`
  const count = workerFailures.get(key) ?? 0
  workerFailures.set(key, count + 1)
  return count < option
}
