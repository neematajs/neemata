import { resolve } from 'node:path'
import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type {
  NeemRuntime,
  NeemRuntimeStartResult,
  NeemRuntimeUpstream,
} from '../../public/runtime.ts'
import type { NeemWorker } from '../../public/worker.ts'
import type {
  NeemRuntimeWorkerData,
  NeemRuntimeWorkerErrorOrigin,
  NeemRuntimeWorkerMessage,
  NeemRuntimeWorkerParentMessage,
} from './worker-protocol.ts'
import {
  createNeemChildLogger,
  createNeemDefaultLogger,
  createNeemRuntimeLabel,
} from './logger.ts'
import {
  createArtifactRegistry,
  importDefault,
  normalizeError,
} from './utils.ts'

if (!parentPort) {
  throw new Error('Neem runtime worker entry requires a parent port')
}

const port = parentPort

const workerData = rawWorkerData as NeemRuntimeWorkerData

let runtime: NeemRuntime | undefined
let runtimeLogger: Logger | undefined
let started = false

function postMessage(message: NeemRuntimeWorkerMessage) {
  port.postMessage(message)
}

function reportError(value: unknown, origin: NeemRuntimeWorkerErrorOrigin) {
  const error = normalizeError(value)
  runtimeLogger?.error(
    new Error(`Neem runtime ${origin} error`, { cause: error }),
  )
  postMessage({
    type: 'error',
    data: {
      message: error.message,
      name: error.name,
      stack: error.stack,
      origin,
    },
  })
}

async function createRuntime(
  data: NeemRuntimeWorkerData,
): Promise<NeemRuntime> {
  return createWorkerRuntime(data)
}

async function createWorkerRuntime(
  data: NeemRuntimeWorkerData,
): Promise<NeemRuntime> {
  const logger = await resolveWorkerLogger(
    data,
    createNeemRuntimeLabel(data.runtimeName, data.name),
  )
  runtimeLogger = logger
  logger.trace(
    { worker: data.name, artifactId: data.artifact.id },
    'Creating Neem worker runtime',
  )
  const worker = await importDefault<NeemWorker<unknown, unknown>>(
    data.artifact.file,
  )

  return worker.createRuntime({
    mode: data.mode,
    name: data.name,
    data: data.data,
    logger,
    definition: worker.definition,
    artifact: data.artifact,
    artifacts: createArtifactRegistry(data.artifacts),
    port: data.port,
  })
}

async function resolveWorkerLogger(data: NeemRuntimeWorkerData, label: string) {
  const logger = data.logger
  if (!logger) {
    return createNeemChildLogger(createNeemDefaultLogger(data.mode), label)
  }
  if (logger.type === 'options') {
    return createNeemChildLogger(
      createNeemDefaultLogger(data.mode, logger.options),
      label,
    )
  }

  return createNeemChildLogger(
    await importDefault<Logger>(resolve(data.outDir, logger.file)),
    label,
  )
}

async function stopRuntime(options: { force?: boolean } = {}) {
  runtimeLogger?.trace('Stopping Neem runtime')
  if (runtime && (started || options.force)) await runtime.stop()
  started = false
  runtimeLogger?.trace('Neem runtime stopped')
}

async function stopAndExit() {
  try {
    await stopRuntime()
    postMessage({ type: 'stopped' })
    workerData.port.close()
    port.close()
  } catch (error) {
    reportError(error, 'runtime')
    process.exit(1)
  }
}

port.on('message', (message: NeemRuntimeWorkerParentMessage) => {
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

async function main() {
  try {
    runtime = await createRuntime(workerData)
  } catch (error) {
    reportError(error, 'bootstrap')
    process.exit(1)
  }

  try {
    const upstreams = normalizeRuntimeUpstreams(await runtime.start())
    started = true
    runtimeLogger?.trace(
      { upstreams: upstreams.length },
      'Neem runtime started',
    )
    postMessage({ type: 'ready', data: { upstreams } })
  } catch (error) {
    await stopRuntime({ force: true }).catch((cleanupError) => {
      runtimeLogger?.warn(
        new Error('Neem runtime cleanup after start error failed', {
          cause: normalizeError(cleanupError),
        }),
      )
    })
    reportError(error, 'start')
    process.exit(1)
  }
}

function normalizeRuntimeUpstreams(
  result: readonly NeemRuntimeUpstream[] | NeemRuntimeStartResult | undefined,
): readonly NeemRuntimeUpstream[] {
  if (!result) return []
  return isRuntimeStartResult(result) ? (result.upstreams ?? []) : result
}

function isRuntimeStartResult(
  result: readonly NeemRuntimeUpstream[] | NeemRuntimeStartResult,
): result is NeemRuntimeStartResult {
  return !Array.isArray(result)
}

void main()
