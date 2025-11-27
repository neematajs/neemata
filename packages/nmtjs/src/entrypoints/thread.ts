import type { MessagePort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { workerData as _workerData } from 'node:worker_threads'

import type { ThreadPortMessage } from '@nmtjs/runtime'

import type { ViteConfigOptions } from '../vite/config.ts'

export type RunWorkerOptions = {
  port: MessagePort
  runtime:
    | { type: 'application'; name: string; path: string; transportsData: any }
    | { type: 'jobs'; jobWorkerQueue: string }
  vite?: { options: ViteConfigOptions; mode: 'development' | 'production' }
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

async function main() {
  let workerModule: typeof import('./worker.ts')

  if (workerData.vite) {
    const { createRunner } = (await import(
      '../vite/runner.ts'
    )) as typeof import('../vite/runner.ts')
    const neemataConfig = await import(workerData.vite.options.configPath).then(
      (m) => m.default as import('../config.ts').NeemataConfig,
    )
    const runner = await createRunner(
      workerData.vite.options,
      workerData.vite.mode,
      neemataConfig,
    )
    workerModule = await runner.import(workerPath)
  } else {
    workerModule = await import(workerPath)
  }

  return workerModule.default(workerData)
}

const runtime = await main()
if (!runtime) throw new Error('Failed to initialize runtime')

const hosts = (await runtime.start()) ?? undefined

workerData.port.postMessage({
  type: 'ready',
  data: { hosts },
} satisfies ThreadPortMessage)

workerData.port.on('message', async (msg) => {
  if (msg.type === 'stop') {
    await runtime.stop()
    process.exit(0)
  }
})
