import { workerData } from 'node:worker_threads'

import type { ServerConfig } from 'nmtjs/runtime'
import {
  ApplicationWorkerRuntime,
  isApplicationConfig,
  JobWorkerRuntime,
} from 'nmtjs/runtime'

import type { RunWorkerOptions } from './thread.ts'

export async function run(options: RunWorkerOptions['runtime']) {
  const serverConfig: ServerConfig = await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default)
  if (options.type === 'application') {
    globalThis._hotAccept = (module: any) => {
      if (module) {
        if (!isApplicationConfig(module.default))
          throw new Error('Invalid application config')
        runtime.reload(module.default)
      }
    }

    const { name, path, transportsData } = options
    const appConfig = await import(
      /* @vite-ignore */
      path
    ).then((m) => m.default)

    const runtime = new ApplicationWorkerRuntime(
      serverConfig,
      { name, path, transports: transportsData },
      appConfig,
    )
    return runtime
  } else if (options.type === 'jobs') {
    const { jobWorkerPool } = options
    const runtime = new JobWorkerRuntime(serverConfig, {
      poolName: jobWorkerPool,
      port: workerData.port,
    })
    return runtime
  } else {
    throw new Error(`Unknown runtime type: ${(workerData.runtime as any).type}`)
  }
}
