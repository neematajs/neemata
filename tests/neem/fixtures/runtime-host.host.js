import { appendFile } from 'node:fs/promises'

async function record(file, event) {
  await appendFile(file, `${event}\n`)
}

const workerFailures = new Map()

export default async function createRuntimeHost(params) {
  await record(params.options.eventFile, `host-setup:${params.name}`)

  return {
    async plan() {
      await record(params.options.eventFile, `host-plan:${params.name}`)
      if (params.options.failPlan) {
        throw new Error('host plan failed')
      }
      const threads = [
        {
          name: `${params.name}:worker`,
          artifact: params.options.useResolvedArtifact
            ? params.artifacts.resolve('entry')
            : 'entry',
          data: {
            eventFile: params.options.eventFile,
            upstreamUrl: params.options.upstreamUrl,
            failAfterStart: shouldFailWorkerAfterStart(params),
          },
        },
      ]
      if (params.options.extraStableWorker) {
        threads.push({
          name: `${params.name}:stable`,
          artifact: params.options.useResolvedArtifact
            ? params.artifacts.resolve('entry')
            : 'entry',
          data: {
            eventFile: params.options.eventFile,
            upstreamUrl: params.options.upstreamUrl,
            failAfterStart: false,
          },
        })
      }
      return { threads }
    },
    async start(startParams) {
      await record(
        params.options.eventFile,
        `host-start:${startParams.threads.length}:${startParams.upstreams.length}`,
      )
      if (params.options.failStart) {
        throw new Error('host start failed')
      }
    },
    async stop(stopParams) {
      await record(
        params.options.eventFile,
        `host-stop:${stopParams.threads.length}`,
      )
      if (params.options.failStop) {
        throw new Error('host stop failed')
      }
    },
    async fail(failParams) {
      await record(
        params.options.eventFile,
        `host-fail:${failParams.threads.length}`,
      )
      if (params.options.failFail) {
        throw new Error('host fail failed')
      }
    },
  }
}

function shouldFailWorkerAfterStart(ctx) {
  const option = ctx.options.failWorkerAfterStart
  if (typeof option !== 'number') return Boolean(option)

  const key = `${ctx.options.eventFile}:${ctx.name}`
  const count = workerFailures.get(key) ?? 0
  workerFailures.set(key, count + 1)
  return count < option
}
