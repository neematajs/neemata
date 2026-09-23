import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from 'pino'

import type { NeemRuntime, NeemRuntimeWorker } from '../../shared/types.ts'
import type {
  ParentMessage,
  RuntimeWorkerData,
  WorkerErrorOrigin,
  WorkerMessage,
} from './protocol.ts'
import { isNeemRuntimeWorker } from '../../public/worker.ts'
import { childLogger, resolveManifestLogger, runtimeLabel } from '../logger.ts'
import { parseRuntimeStartResult } from '../schemas/runtime.ts'
import { importDefault, normalizeError, serializeError } from '../utils.ts'

if (!parentPort) {
  throw new Error('Neem runtime worker entry requires a parent port')
}

const port = parentPort
const workerData = rawWorkerData as RuntimeWorkerData

let runtime: NeemRuntime | undefined
let logger: Logger | undefined
let stopping: Promise<void> | undefined
let stopRequested = false

function postMessage(message: WorkerMessage): void {
  port.postMessage(message)
}

function reportError(value: unknown, origin: WorkerErrorOrigin): void {
  // This thread is the only place the real value still exists, so it is
  // logged here in full; the parent only receives a rendered summary.
  if (value instanceof Error) {
    logger?.error(new Error(`Neem runtime ${origin} error`, { cause: value }))
  } else {
    logger?.error({ err: value }, `Neem runtime ${origin} error`)
  }
  postMessage({ type: 'error', data: { ...serializeError(value), origin } })
}

async function createRuntime(data: RuntimeWorkerData): Promise<NeemRuntime> {
  logger = await resolveWorkerLogger(
    data,
    runtimeLabel(data.runtimeName, data.name),
  )
  logger.trace(
    { artifactId: data.artifact.id, file: data.artifact.file },
    'Neem runtime worker initializing',
  )
  const worker = await importDefault<NeemRuntimeWorker<unknown, unknown>>(
    data.artifact.file,
  )
  if (!isNeemRuntimeWorker(worker)) {
    throw new Error(
      `Runtime worker file [${data.artifact.file}] default export must be a marked runtime worker produced by defineRuntimeWorker`,
    )
  }

  const created = worker.createRuntime({
    mode: data.mode,
    name: data.name,
    data: data.data,
    logger,
    definition: worker.definition,
    port: data.port,
  })
  logger.trace('Neem runtime worker initialized')
  return created
}

async function resolveWorkerLogger(
  data: RuntimeWorkerData,
  label: string,
): Promise<Logger> {
  return childLogger(
    await resolveManifestLogger(data.logger, {
      mode: data.mode,
      outDir: data.outDir,
    }),
    label,
  )
}

function stopRuntime(): Promise<void> {
  // The factory may still be resolving when stop arrives. Its eventual runtime
  // must be stopped once, even if start has not completed (or has not run yet).
  return (stopping ??= (async () => {
    const current = runtime ?? (await initialization)
    logger?.trace('Stopping Neem runtime worker')
    await current.stop()
    logger?.trace('Neem runtime worker stopped')
  })())
}

async function stopAndExit(): Promise<void> {
  if (stopRequested) return
  stopRequested = true
  try {
    await stopRuntime()
    postMessage({ type: 'stopped' })
    workerData.port.close()
    port.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.exit(0)
  } catch (error) {
    reportError(error, 'runtime')
    process.exit(1)
  }
}

async function watchRuntimeFinished(current: NeemRuntime): Promise<void> {
  if (!current.finished) return

  try {
    await current.finished
    if (stopRequested) return
    reportError(
      new Error('Neem runtime finished before stop was requested'),
      'runtime',
    )
  } catch (error) {
    if (stopRequested) return
    reportError(error, 'runtime')
  }
  process.exit(1)
}

port.on('message', (message: ParentMessage) => {
  if (message?.type === 'stop') void stopAndExit()
})

process.on('uncaughtException', (error) => {
  reportError(error, 'runtime')
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  reportError(error, 'runtime')
  process.exit(1)
})

async function main(): Promise<void> {
  try {
    runtime = await initialization
  } catch (error) {
    if (stopRequested) return
    reportError(error, 'bootstrap')
    process.exit(1)
  }

  if (stopRequested) return
  try {
    logger?.trace('Starting Neem runtime worker')
    const result = await runtime.start()
    if (stopRequested) return
    const upstreams = parseRuntimeStartResult(result)
    logger?.trace({ upstreams: upstreams.length }, 'Neem runtime worker ready')
    postMessage({ type: 'ready', data: { upstreams } })
    void watchRuntimeFinished(runtime)
  } catch (error) {
    if (stopRequested) return
    await stopRuntime().catch((cleanupError) => {
      logger?.warn(
        new Error('Neem runtime cleanup after start error failed', {
          cause: normalizeError(cleanupError),
        }),
      )
    })
    if (stopRequested) return
    reportError(error, 'start')
    process.exit(1)
  }
}

const initialization = createRuntime(workerData)
void main()
