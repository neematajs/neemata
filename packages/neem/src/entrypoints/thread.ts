import type { MessagePort } from 'node:worker_threads'
import { isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { workerData as _workerData } from 'node:worker_threads'

import type { ModuleRunner } from 'vite/module-runner'
import { createLogger } from '@nmtjs/core'

import type {
  ApplicationRuntime,
  ServerPortMessage,
  ThreadErrorMessage,
  ThreadPortMessage,
  WorkerThreadErrorOrigin,
} from '../types.ts'

type ApplicationThreadRuntime = {
  type: 'application'
  name: string
  entrypoint: string
  options: unknown
}

type WorkerModule = typeof import('./worker.ts')

type NeemThreadWorkerData = {
  port: MessagePort
  mode?: 'development' | 'production'
  moduleLoader?: 'runner' | 'native'
  runtime: ApplicationThreadRuntime
}

const workerData = _workerData as NeemThreadWorkerData
const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
const workerPath = fileURLToPath(new URL(`./worker${ext}`, import.meta.url))

const logger = createLogger(
  {
    pinoOptions: {
      level: workerData.mode === 'development' ? 'debug' : 'info',
    },
  },
  'NeemThread',
)

const kReportedError = Symbol.for('nmtjs.worker.reported-error')

let runner: ModuleRunner | null = null
let workerModule: WorkerModule | null = null
let runtime: ApplicationRuntime | null = null
let runtimeStarted = false
let cleanupPromise: Promise<void> | null = null

process.on('uncaughtException', (error) => {
  reportError(error, 'runtime', { fatal: true })
})

process.on('unhandledRejection', (error) => {
  reportError(error, 'runtime', { fatal: true })
})

process.once('SIGTERM', () => {
  void terminate(0)
})

process.once('SIGINT', () => {
  void terminate(0)
})

process.once('beforeExit', () => {
  if (!cleanupPromise && (runtimeStarted || runner)) {
    void cleanup()
  }
})

async function cleanup() {
  if (cleanupPromise) return cleanupPromise

  cleanupPromise = (async () => {
    await stopRuntime()
    await closeRunner()
  })().finally(() => {
    cleanupPromise = null
  })

  return cleanupPromise
}

async function terminate(code: number) {
  await cleanup()
  process.exit(code)
}

async function closeRunner() {
  if (!runner) return
  try {
    await runner.close()
  } catch (error) {
    reportError(error, 'runtime', { fatal: false })
  } finally {
    runner = null
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
    runtime = null
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

    logger.error(new Error(`Worker thread ${origin} error`, { cause: error }))
    ;(error as any)[kReportedError] = true
  }

  return error
}

async function importWorkerModule(entrypoint: string): Promise<unknown> {
  if (shouldUseModuleRunner()) {
    if (!runner) {
      throw new Error('Worker module runner is not initialized')
    }

    return await runner.import(entrypoint)
  }

  return await import(/* @vite-ignore */ resolveModuleSpecifier(entrypoint))
}

async function initializeRuntime() {
  const mode = workerData.mode ?? 'production'
  if (shouldUseModuleRunner()) {
    const { createPoolModuleRunner } = await import('../vite/runner.ts')
    runner = await createPoolModuleRunner(mode, 5000, workerData)
  } else {
    runner = null
  }

  workerModule = (await importWorkerModule(workerPath)) as WorkerModule

  runtime = await workerModule.run(workerData.runtime, mode, importWorkerModule)

  workerData.port.on('message', async (msg: ServerPortMessage) => {
    if (msg.type === 'stop') {
      await terminate(0)
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
  await initializeRuntime()
  await startRuntime()
}

main().catch(async (error) => {
  const normalized = error instanceof Error ? error : normalizeError(error)
  if (!(normalized as any)[kReportedError]) {
    reportError(normalized, 'bootstrap')
  }
  await terminate(1)
})

function shouldUseModuleRunner(): boolean {
  return workerData.moduleLoader !== 'native'
}

function resolveModuleSpecifier(entrypoint: string): string {
  if (entrypoint.startsWith('file:') || entrypoint.startsWith('node:')) {
    return entrypoint
  }

  if (isAbsolute(entrypoint)) {
    return pathToFileURL(entrypoint).href
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(entrypoint)) {
    return entrypoint
  }

  return new URL(entrypoint, import.meta.url).href
}
