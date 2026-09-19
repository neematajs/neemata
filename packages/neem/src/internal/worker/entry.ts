import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type { NeemWorkerErrorOrigin } from '../../shared/errors.ts'
import type { NeemRuntime, NeemRuntimeWorker } from '../../shared/types.ts'
import type {
  ParentMessage,
  RuntimeWorkerData,
  WorkerMessage,
} from './protocol.ts'
import { isNeemRuntimeWorker } from '../../public/worker.ts'
import { childLogger, resolveManifestLogger, runtimeLabel } from '../logger.ts'
import { parseRuntimeStartResult } from '../schemas/runtime.ts'
import { closeAndExit } from '../threads.ts'
import { importDefault, normalizeError, serializeError } from '../utils.ts'

if (!parentPort) {
  throw new Error('Neem runtime worker entry requires a parent port')
}

const port = parentPort
const workerData = rawWorkerData as RuntimeWorkerData

let runtime: NeemRuntime | undefined
// The crash handlers below are installed before the logger can be resolved.
let logger: Logger | undefined
let started = false
let stopRequested = false

function post(message: WorkerMessage): void {
  port.postMessage(message)
}

function reportError(value: unknown, origin: NeemWorkerErrorOrigin): void {
  // This thread is the only place the real value still exists, so it is
  // logged here in full; the parent only receives a rendered summary.
  if (value instanceof Error) {
    logger?.error(new Error(`Neem runtime ${origin} error`, { cause: value }))
  } else {
    logger?.error({ err: value }, `Neem runtime ${origin} error`)
  }
  post({ type: 'error', data: { ...serializeError(value), origin } })
}

async function createRuntime(
  data: RuntimeWorkerData,
  logger: Logger,
): Promise<NeemRuntime> {
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

async function stopRuntime(): Promise<void> {
  if (runtime && started) {
    logger?.trace('Stopping Neem runtime worker')
    await runtime.stop()
    logger?.trace('Neem runtime worker stopped')
  }
  started = false
}

async function stopAndExit(): Promise<void> {
  stopRequested = true
  try {
    await stopRuntime()
    post({ type: 'stopped' })
    await closeAndExit(workerData.port, port)
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
  if (message.type === 'stop') void stopAndExit()
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
    logger = childLogger(
      await resolveManifestLogger(workerData.logger, {
        mode: workerData.mode,
        outDir: workerData.outDir,
      }),
      runtimeLabel(workerData.runtimeName, workerData.name),
    )
    runtime = await createRuntime(workerData, logger)
  } catch (error) {
    reportError(error, 'bootstrap')
    process.exit(1)
  }

  try {
    logger.trace('Starting Neem runtime worker')
    const result = await runtime.start()
    const upstreams = parseRuntimeStartResult(result)
    started = true
    logger.trace({ upstreams: upstreams.length }, 'Neem runtime worker ready')
    post({ type: 'ready', data: { upstreams } })
    void watchRuntimeFinished(runtime)
  } catch (error) {
    try {
      await runtime.stop()
    } catch (cleanupError) {
      logger.warn(
        new Error('Neem runtime cleanup after start error failed', {
          cause: normalizeError(cleanupError),
        }),
      )
    }
    reportError(error, 'start')
    process.exit(1)
  }
}

void main()
