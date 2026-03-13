import { HttpTransport } from '@nmtjs/http-transport/node'
import { defineApplication } from '@nmtjs/neem'
import { n, t } from 'nmtjs'
import { ApplicationWorkerRuntime } from 'nmtjs/runtime'

function createNmtjsAppConfig(applicationName) {
  return n.app({
    transports: { http: HttpTransport },
    router: n.rootRouter([
      n.router({
        routes: {
          ping: n.procedure({
            input: t.object({}),
            output: t.object({ message: t.string(), app: t.string() }),
            handler: () => ({ message: 'pong', app: applicationName }),
          }),
        },
      }),
    ]),
  })
}

const adapter = {
  id: 'neem-e2e-nmtjs',
  async createRuntime({ applicationName, mode, threadOptions }) {
    const serverConfig = n.server({
      logger: {
        pinoOptions: { level: mode === 'development' ? 'debug' : 'info' },
      },
      applications: { [applicationName]: { threads: [] } },
    })

    let appConfig = createNmtjsAppConfig(applicationName)
    let runtime = null

    return {
      async start() {
        runtime = new ApplicationWorkerRuntime(
          serverConfig,
          {
            name: applicationName,
            path: import.meta.url,
            transports: threadOptions ?? {},
          },
          appConfig,
        )

        return await runtime.start()
      },
      async stop() {
        if (!runtime) return

        const runtimeToStop = runtime
        runtime = null
        await runtimeToStop.stop()
      },
      async reload() {
        if (!runtime) return

        appConfig = createNmtjsAppConfig(applicationName)
        await runtime.reload(appConfig)
      },
    }
  },
}

export default defineApplication({ adapter, commands: [], definition: {} })
