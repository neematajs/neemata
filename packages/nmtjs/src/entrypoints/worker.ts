import type { ServerConfig } from '@nmtjs/runtime'
import { ApplicationWorkerRuntime, JobWorkerRuntime } from '@nmtjs/runtime'

import type { RunWorkerOptions } from './thread.ts'

export default async function run(options: RunWorkerOptions) {
  const serverConfig: ServerConfig = await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default)

  if (options.runtime.type === 'application') {
    const { name, path, transportsData } = options.runtime
    const runtime = new ApplicationWorkerRuntime(serverConfig, {
      name,
      path,
      transports: transportsData,
    })

    if (import.meta.env.DEV && import.meta.hot) {
      import.meta.hot.accept(path, async (module) => {
        if (module) {
          runtime.logger.info('Configuration changed, performing reload...')
          await runtime.reload()
        }
      })
    }

    return runtime
  } else if (options.runtime.type === 'jobs') {
    const { jobWorkerQueue } = options.runtime
    const runtime = new JobWorkerRuntime(serverConfig, {
      queueName: jobWorkerQueue,
      port: options.port,
    })
    return runtime
  }
}
