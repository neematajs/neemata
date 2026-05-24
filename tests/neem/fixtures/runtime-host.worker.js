import { appendFile } from 'node:fs/promises'

async function record(file, event) {
  await appendFile(file, `${event}\n`)
}

export default {
  definition: {},
  createRuntime(ctx) {
    return {
      async start() {
        await record(ctx.data.eventFile, `worker-start:${ctx.name}`)
        if (ctx.data.failAfterStart) {
          setTimeout(() => {
            throw new Error(`worker failed after start ${ctx.name}`)
          }, 25)
        }
        return { upstreams: [{ type: 'http', url: ctx.data.upstreamUrl }] }
      },
      async stop() {
        await record(ctx.data.eventFile, `worker-stop:${ctx.name}`)
      },
    }
  },
}
