import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { NeemApp } from '../../public/app.ts'
import type { NeemConfig } from '../../public/config.ts'
import type { NeemRuntime } from '../../public/runtime.ts'
import type { NeemWorker } from '../../public/worker.ts'
import type {
  NeemAppRuntimeWorkerData,
  NeemGenericRuntimeWorkerData,
  NeemRuntimeWorkerData,
  NeemRuntimeWorkerErrorOrigin,
  NeemRuntimeWorkerMessage,
  NeemRuntimeWorkerParentMessage,
  NeemRuntimeWorkerReloadData,
} from './worker-protocol.ts'
import { createNeemChildLogger, resolveNeemConfigLogger } from './logger.ts'
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
let started = false

function postMessage(message: NeemRuntimeWorkerMessage) {
  port.postMessage(message)
}

function reportError(value: unknown, origin: NeemRuntimeWorkerErrorOrigin) {
  const error = normalizeError(value)
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
  if (data.kind === 'app') {
    return createAppRuntime(data)
  }

  return createWorkerRuntime(data)
}

async function createWorkerRuntime(
  data: NeemGenericRuntimeWorkerData,
): Promise<NeemRuntime> {
  const logger = await resolveWorkerLogger(data.configFile, data.name)
  const worker = await importDefault<NeemWorker<any, any>>(data.artifact.file)

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

async function createAppRuntime(
  data: NeemAppRuntimeWorkerData,
): Promise<NeemRuntime> {
  const logger = await resolveWorkerLogger(
    data.configFile,
    `App/${data.appName}:${data.threadIndex}`,
  )
  const app = await importDefault<NeemApp<any, any>>(data.artifact.file)

  return app.createRuntime({
    mode: data.mode,
    appName: data.appName,
    threadIndex: data.threadIndex,
    threadOptions: data.threadOptions,
    logger,
    definition: app.definition,
    artifact: data.artifact,
    artifacts: createArtifactRegistry(data.artifacts),
  })
}

async function resolveWorkerLogger(configFile: string, label: string) {
  const config = await importDefault<NeemConfig>(configFile)
  return createNeemChildLogger(await resolveNeemConfigLogger(config), label)
}

async function stopRuntime() {
  if (runtime && started) await runtime.stop()
  started = false
}

async function reloadRuntime(data: NeemRuntimeWorkerReloadData) {
  if (!runtime?.reload) {
    throw new Error('Runtime does not implement reload')
  }
  const upstreams = (await runtime.reload({ reason: 'artifact' })) ?? []
  postMessage({ type: 'reloaded', data: { upstreams } })
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
  if (message?.type === 'reload') {
    void reloadRuntime(message.data).catch((error) => {
      reportError(error, 'reload')
    })
  }
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
    const upstreams = (await runtime.start()) ?? []
    started = true
    postMessage({ type: 'ready', data: { upstreams } })
  } catch (error) {
    reportError(error, 'start')
    process.exit(1)
  }
}

void main()
