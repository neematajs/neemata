import type { MessagePort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { workerData as _workerData, parentPort } from 'node:worker_threads'

import type { ApplicationType, ApplicationWorkerType } from '@nmtjs/application'
import type { ServerPortMessage, ThreadPortMessage } from '@nmtjs/runtime'

import type { ViteConfigOptions } from '../vite/config.ts'

export type RunWorkerOptions = {
  workerType: ApplicationWorkerType
  type: ApplicationType
  applicationWorkerData: any
  port: MessagePort
  vite?: { options: ViteConfigOptions; mode: 'development' | 'production' }
}

const workerData = _workerData as RunWorkerOptions

const workerPath = fileURLToPath(import.meta.resolve('./worker'))

process.on('uncaughtException', (error) => {
  console.error(error)
})

process.on('unhandledRejection', (error) => {
  console.error(error)
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

workerData.port.on('message', async (msg: ThreadPortMessage) => {
  switch (msg.type) {
    case 'task': {
      const { id, data } = msg.data
      const result = await worker.runJob(data)
      workerData.port.postMessage({
        type: 'task',
        data: { id, data: result },
      } satisfies ServerPortMessage)
      break
    }
    case 'stop': {
      workerData.port.removeAllListeners()
      workerData.port.unref()
      await worker.stop()
      process.exit(0)
    }
  }
})

const worker = await main()
await worker.start()
workerData.port.postMessage({ type: 'ready' } satisfies ServerPortMessage)
