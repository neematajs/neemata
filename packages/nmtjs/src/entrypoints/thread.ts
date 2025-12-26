import type { MessagePort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { workerData as _workerData } from 'node:worker_threads'

import type {
  ThreadErrorMessage,
  ThreadPortMessage,
  WorkerThreadErrorOrigin,
} from 'nmtjs/runtime'
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

type WorkerModule = typeof import('./worker.ts')
type WorkerRuntime = Awaited<ReturnType<WorkerModule['run']>>

const kReportedError = Symbol.for('nmtjs.worker.reported-error')

let runner: ModuleRunner | undefined
let workerModule: WorkerModule
let runtime: WorkerRuntime | undefined
let runtimeStarted = false

process.on('uncaughtException', (error) => {
  reportError(error, 'runtime', { fatal: true })
})

process.on('unhandledRejection', (error) => {
  reportError(error, 'runtime', { fatal: true })
})

process.on('exit', () => {
  void cleanup()
})

async function cleanup() {
  await stopRuntime()
  await closeRunner()
}

async function closeRunner() {
  if (!runner) return
  try {
    await runner.close()
  } catch (error) {
    reportError(error, 'runtime', { fatal: false })
  } finally {
    runner = undefined
  }
}

async function stopRuntime() {
  if (!runtime) return
  try {
    if (runtimeStarted) {
      await runtime.stop()
    }
  } catch (error) {
    reportError(error, 'runtime', { fatal: false })
  } finally {
    runtimeStarted = false
  }
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object') {
    try {
      return new Error(JSON.stringify(value))
    } catch {}
  }
  return new Error(String(value))
}

function serializeError(
  error: Error,
  origin: WorkerThreadErrorOrigin,
  fatal: boolean,
): ThreadErrorMessage {
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    origin,
    fatal,
  }
}

function reportError(
  value: unknown,
  origin: WorkerThreadErrorOrigin,
  options: { fatal?: boolean } = {},
): Error {
  const fatal = options.fatal ?? origin !== 'runtime'
  const error = normalizeError(value)
  if (!(error as any)[kReportedError]) {
    try {
      workerData.port.postMessage({
        type: 'error',
        data: serializeError(error, origin, fatal),
      } satisfies ThreadPortMessage)
    } catch {}
    console.error(new Error(`Worker thread ${origin} error`, { cause: error }))
    ;(error as any)[kReportedError] = true
  }
  return error
}

async function loadWorkerModule() {
  try {
    if (workerData.vite) {
      const { createModuleRunner } = (await import(
        '../vite/runners/worker.ts'
      )) as typeof import('../vite/runners/worker.ts')

      runner = createModuleRunner(workerData.vite)
      workerModule = await runner.import(workerPath)
    } else {
      runner = undefined
      workerModule = await import(
        /* @vite-ignore */
        workerPath
      )
    }
  } catch (error) {
    throw reportError(error, 'bootstrap')
  }
}

async function initializeRuntime() {
  try {
    runtime = await workerModule.run(workerData.runtime)
  } catch (error) {
    throw reportError(error, 'bootstrap')
  }

  workerData.port.on('message', async (msg) => {
    if (msg.type === 'stop') {
      await cleanup()
      process.exit(0)
    }
  })
}

async function startRuntime() {
  if (!runtime) return
  try {
    const hosts = (await runtime.start()) || undefined
    runtimeStarted = true
    workerData.port.postMessage({
      type: 'ready',
      data: { hosts },
    } satisfies ThreadPortMessage)
  } catch (error) {
    throw reportError(error, 'start')
  }
}

async function main() {
  await loadWorkerModule()
  await initializeRuntime()
  await startRuntime()
}

main().catch(async (error) => {
  const normalized = error instanceof Error ? error : normalizeError(error)
  if (!(normalized as any)[kReportedError]) {
    reportError(normalized, 'bootstrap')
  }
  await cleanup()
  process.exit(1)
})
