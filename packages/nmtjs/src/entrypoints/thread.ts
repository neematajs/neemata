import type { MessagePort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { workerData as _workerData } from 'node:worker_threads'

import type { ThreadPortMessage } from 'nmtjs/runtime'
import type { ModuleRunner } from 'vite/module-runner'

export type RunWorkerOptions = {
  port: MessagePort
  runtime:
    | { type: 'application'; name: string; path: string; transportsData: any }
    | { type: 'jobs'; jobWorkerPool: string }
  vite?: 'development' | 'production'
}

const workerData = _workerData as RunWorkerOptions

const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
const workerPath = fileURLToPath(import.meta.resolve(`./worker${ext}`))

process.on('uncaughtException', (error) => {
  console.error(new Error('Uncaught Exception:', { cause: error }))
})

process.on('unhandledRejection', (error) => {
  console.error(new Error('Unhandled Promise Rejection:', { cause: error }))
})

process.on('exit', async (code) => {
  await runner?.close()
})

let runner: ModuleRunner
let workerModule: typeof import('./worker.ts')

try {
  if (workerData.vite) {
    const { createModuleRunner } = (await import(
      '../vite/runners/worker.ts'
    )) as typeof import('../vite/runners/worker.ts')

    runner = createModuleRunner(workerData.vite)
    workerModule = await runner.import(workerPath)
  } else {
    runner = undefined as any
    workerModule = await import(
      /* @vite-ignore */
      workerPath
    )
  }

  const runtime = await workerModule.run(workerData.runtime)

  process.on('exit', async () => {
    await runtime.stop()
  })

  workerData.port.on('message', async (msg) => {
    if (msg.type === 'stop') {
      await runtime.stop()
      process.exit(0)
    }
  })

  const hosts = (await runtime?.start()) || undefined

  workerData.port.postMessage({
    type: 'ready',
    data: { hosts },
  } satisfies ThreadPortMessage)
} catch (error) {
  console.error(new Error('Worker thread error:', { cause: error }))
}
