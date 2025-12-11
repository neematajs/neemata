import type { Worker } from 'node:worker_threads'
import EventEmitter from 'node:events'
import { fileURLToPath } from 'node:url'

import type { ServerConfig } from '@nmtjs/runtime'
import type { ViteDevServer } from 'vite'
import { ApplicationServer, isServerConfig } from '@nmtjs/runtime'

declare global {
  const __VITE_CONFIG__: string
  const __APPLICATIONS_CONFIG__: string
}

class InvalidServerConfigError extends Error {
  constructor() {
    super(
      `Server config file does not have a default export, or it not a valid application. Please, make sure the application is defined using defineApplication().`,
    )
    this.name = 'InvalidServerConfigError'
  }
}

const _ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
const _vite = __VITE_CONFIG__ ? JSON.parse(__VITE_CONFIG__) : undefined
const applicationsConfig = __APPLICATIONS_CONFIG__
  ? JSON.parse(__APPLICATIONS_CONFIG__)
  : {}

let _viteServerEvents: EventEmitter<{ worker: [Worker] }> | undefined
let _viteWorkerServer: ViteDevServer | undefined

let server: ApplicationServer

if (import.meta.env.DEV && import.meta.hot) {
  import.meta.hot.accept('#server', async (module) => {
    await server.stop()
    await createServer(module?.default)
  })
}

if (_vite) {
  const { createWorkerServer } = await import('../vite/servers/worker.ts')
  const neemataConfig = await import(
    /* @vite-ignore */
    _vite.options.configPath
  ).then((m) => m.default as import('../config.ts').NeemataConfig)
  _viteServerEvents = new EventEmitter<{ worker: [Worker] }>()
  _viteWorkerServer = await createWorkerServer(
    _vite.options,
    _vite.mode,
    neemataConfig,
    _viteServerEvents,
  )
}

async function createServer(config: ServerConfig) {
  if (!isServerConfig(config)) throw new InvalidServerConfigError()
  server = new ApplicationServer(config, applicationsConfig, {
    path: fileURLToPath(import.meta.resolve(`./thread${_ext}`)),
    workerData: { vite: _vite?.mode },
    worker: _viteServerEvents
      ? (worker) => {
          _viteServerEvents.emit('worker', worker)
        }
      : undefined,
  })
  await server.start()
}

let isTerminating = false

async function handleTermination() {
  if (isTerminating) return
  isTerminating = true
  await server?.stop()
  _viteWorkerServer?.close()
  process.exit(0)
}

function handleUnexpectedError(error: Error) {
  console.error(new Error('Unexpected Error:', { cause: error }))
}

process.once('SIGTERM', handleTermination)
process.once('SIGINT', handleTermination)
process.on('uncaughtException', handleUnexpectedError)
process.on('unhandledRejection', handleUnexpectedError)

await createServer(
  await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default),
)

const { format } = Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 2,
  unit: 'byte',
})

const printMem = () => {
  globalThis.gc?.()
  // print memory usage every 10 seconds
  const memoryUsage = process.memoryUsage()
  console.log(
    `Memory Usage: RSS=${format(memoryUsage.rss)}, HeapTotal=${format(memoryUsage.heapTotal)}, HeapUsed=${format(memoryUsage.heapUsed)}, External=${format(memoryUsage.external)}, ArrayBuffers=${format(memoryUsage.arrayBuffers)}`,
  )
}
// printMem()
// setInterval(printMem, 5000)
