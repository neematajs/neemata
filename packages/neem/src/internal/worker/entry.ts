import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type {
  NeemRuntime,
  NeemRuntimeStartResult,
  NeemRuntimeUpstream,
} from '../../public/runtime.ts'
import type { NeemWorker } from '../../public/worker.ts'
import type {
  ParentMessage,
  RuntimeWorkerData,
  WorkerErrorOrigin,
  WorkerMessage,
} from './protocol.ts'
import { createArtifactRegistry } from '../manifest/artifacts.ts'
import {
  childLogger,
  resolveManifestLogger,
  runtimeLabel,
} from '../shared/logger.ts'
import { importDefault, normalizeError } from '../shared/utils.ts'

if (!parentPort) {
  throw new Error('Neem runtime worker entry requires a parent port')
}

const port = parentPort
const workerData = rawWorkerData as RuntimeWorkerData

let runtime: NeemRuntime | undefined
let logger: Logger | undefined
let started = false

function postMessage(message: WorkerMessage): void {
  port.postMessage(message)
}

function reportError(value: unknown, origin: WorkerErrorOrigin): void {
  const error = normalizeError(value)
  logger?.error(new Error(`Neem runtime ${origin} error`, { cause: error }))
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

async function createRuntime(data: RuntimeWorkerData): Promise<NeemRuntime> {
  logger = await resolveWorkerLogger(
    data,
    runtimeLabel(data.runtimeName, data.name),
  )
  logger.trace(
    { artifactId: data.artifact.id, file: data.artifact.file },
    'Neem runtime worker initializing',
  )
  const worker = await importDefault<NeemWorker<unknown, unknown>>(
    data.artifact.file,
  )

  const created = worker.createRuntime({
    mode: data.mode,
    name: data.name,
    data: data.data,
    logger,
    definition: worker.definition,
    artifact: data.artifact,
    artifacts: createArtifactRegistry(data.artifacts),
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

async function stopRuntime(options: { force?: boolean } = {}): Promise<void> {
  if (runtime && (started || options.force)) {
    logger?.trace({ force: options.force }, 'Stopping Neem runtime worker')
    await runtime.stop()
    logger?.trace('Neem runtime worker stopped')
  }
  started = false
}

async function stopAndExit(): Promise<void> {
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
    runtime = await createRuntime(workerData)
  } catch (error) {
    reportError(error, 'bootstrap')
    process.exit(1)
  }

  try {
    logger?.trace('Starting Neem runtime worker')
    const result = await runtime.start()
    const upstreams =
      result === undefined
        ? []
        : Array.isArray(result)
          ? (result as readonly NeemRuntimeUpstream[])
          : ((result as NeemRuntimeStartResult).upstreams ?? [])
    started = true
    logger?.trace({ upstreams: upstreams.length }, 'Neem runtime worker ready')
    postMessage({ type: 'ready', data: { upstreams } })
  } catch (error) {
    await stopRuntime({ force: true }).catch((cleanupError) => {
      logger?.warn(
        new Error('Neem runtime cleanup after start error failed', {
          cause: normalizeError(cleanupError),
        }),
      )
    })
    reportError(error, 'start')
    process.exit(1)
  }
}

void main()
