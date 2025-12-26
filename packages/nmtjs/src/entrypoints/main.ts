import type { Worker } from 'node:worker_threads'
import EventEmitter from 'node:events'
import { fileURLToPath } from 'node:url'

import type {
  ApplicationWorkerErrorEvent,
  ApplicationWorkerReadyEvent,
  ServerConfig,
} from 'nmtjs/runtime'
import type { ViteDevServer } from 'vite'
import { ApplicationServer, isServerConfig } from 'nmtjs/runtime'

import type { WorkerServerEventMap as BaseWorkerServerEventMap } from '../vite/servers/worker.ts'

declare global {
  const __VITE_CONFIG__: string
  const __APPLICATIONS_CONFIG__: string
}

class InvalidServerConfigError extends Error {
  constructor() {
    super(
      `Server config file does not have a default export, or it is not a valid server config. Please, make sure the server config is defined using defineServer().`,
    )
    this.name = 'InvalidServerConfigError'
  }
}

const _ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
const _vite = __VITE_CONFIG__ ? JSON.parse(__VITE_CONFIG__) : undefined
const applicationsConfig: Record<
  string,
  { type: 'neemata' | 'custom'; specifier: string }
> = __APPLICATIONS_CONFIG__ ? JSON.parse(__APPLICATIONS_CONFIG__) : {}

type WorkerEventMap = BaseWorkerServerEventMap & {
  'worker-error': [ApplicationWorkerErrorEvent]
  'worker-ready': [ApplicationWorkerReadyEvent]
}

let _viteServerEvents: EventEmitter<WorkerEventMap> | undefined
let _viteWorkerServer: ViteDevServer | undefined

let server: ApplicationServer | undefined
let hasActiveWorkerError = false
const isDev = _vite?.mode === 'development'

if (import.meta.env.DEV && import.meta.hot) {
  import.meta.hot.accept('#server', async (module) => {
    await shutdownServer()
    await bootWithHandling(module?.default)
  })
}

if (_vite) {
  const { createWorkerServer } = await import('../vite/servers/worker.ts')
  const neemataConfig = await import(
    /* @vite-ignore */
    _vite.options.configPath
  ).then((m) => m.default as import('../config.ts').NeemataConfig)
  _viteServerEvents = new EventEmitter<WorkerEventMap>()
  _viteServerEvents.on('worker-error', handleWorkerError)
  _viteServerEvents.on('worker-ready', handleWorkerReady)
  _viteWorkerServer = await createWorkerServer(
    _vite.options,
    _vite.mode,
    neemataConfig,
    _viteServerEvents,
  )
}

async function bootServer(configValue: ServerConfig | undefined) {
  if (!isServerConfig(configValue)) throw new InvalidServerConfigError()
  const workerConfig = {
    path: fileURLToPath(import.meta.resolve(`./thread${_ext}`)),
    workerData: { vite: _vite?.mode },
    worker: _viteServerEvents
      ? (worker: Worker) => {
          _viteServerEvents.emit('worker', worker)
        }
      : undefined,
    events: _viteServerEvents,
  }
  const appServer = new ApplicationServer(
    configValue,
    applicationsConfig,
    workerConfig,
  )

  try {
    await appServer.start()
    server = appServer
    clearWorkerErrorOverlay()
  } catch (error) {
    await appServer.stop().catch(() => {})
    throw error
  }
}

async function bootWithHandling(configValue: ServerConfig | undefined) {
  try {
    await bootServer(configValue)
  } catch (error) {
    handleStartupError(error)
    if (!isDev) throw error
  }
}

let isTerminating = false

async function handleTermination() {
  if (isTerminating) return
  isTerminating = true
  await shutdownServer()
  _viteWorkerServer?.close()
  process.exit(0)
}

function handleUnexpectedError(error: Error) {
  console.error(new Error('Unexpected Error:', { cause: error }))
}

async function shutdownServer() {
  if (!server) return
  try {
    await server.stop()
  } catch (error) {
    console.error(
      new Error('Failed to stop application server', { cause: error as Error }),
    )
  } finally {
    server = undefined
  }
}

function handleWorkerError(event: ApplicationWorkerErrorEvent) {
  hasActiveWorkerError = true
  console.error(
    new Error(`Worker ${event.application} thread ${event.threadId} error`, {
      cause: event.error,
    }),
  )
}

function handleWorkerReady(_: ApplicationWorkerReadyEvent) {
  clearWorkerErrorOverlay()
}

function handleStartupError(error: unknown) {
  const normalized = error instanceof Error ? error : new Error(String(error))
  if (_viteServerEvents) {
    _viteServerEvents.emit('worker-error', {
      application: 'server',
      threadId: -1,
      error: normalized,
    } as ApplicationWorkerErrorEvent)
  } else {
    hasActiveWorkerError = true
    console.error(
      new Error('Failed to start application server', { cause: normalized }),
    )
  }
}

function clearWorkerErrorOverlay() {
  if (!hasActiveWorkerError) return
  hasActiveWorkerError = false
}

process.once('SIGTERM', handleTermination)
process.once('SIGINT', handleTermination)
process.on('uncaughtException', handleUnexpectedError)
process.on('unhandledRejection', handleUnexpectedError)

await bootWithHandling(
  await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default),
).catch(() => {
  if (!isDev) process.exit(1)
})

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
void printMem
// printMem()
// setInterval(printMem, 5000)
