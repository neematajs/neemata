import { pathToFileURL } from 'node:url'
import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { NeemApp } from '../public/app.ts'
import type {
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '../public/artifact.ts'
import type { NeemRuntime } from '../public/runtime.ts'
import type {
  NeemAppWorkerData,
  NeemAppWorkerErrorOrigin,
  NeemAppWorkerMessage,
  NeemAppWorkerParentMessage,
} from './app-worker-protocol.ts'

const port = (() => {
  if (!parentPort) {
    throw new Error('Neem app worker entry requires a parent port')
  }
  return parentPort
})()

const workerData = rawWorkerData as NeemAppWorkerData

let runtime: NeemRuntime | undefined
let started = false

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  try {
    return new Error(JSON.stringify(value))
  } catch {
    return new Error(String(value))
  }
}

function serializeError(
  value: unknown,
  origin: NeemAppWorkerErrorOrigin,
): Extract<NeemAppWorkerMessage, { type: 'error' }>['data'] {
  const error = normalizeError(value)
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    origin,
  }
}

function postMessage(message: NeemAppWorkerMessage) {
  port.postMessage(message)
}

function reportError(value: unknown, origin: NeemAppWorkerErrorOrigin) {
  postMessage({ type: 'error', data: serializeError(value, origin) })
}

function createArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): NeemArtifactRegistry {
  const byId = new Map<string, NeemResolvedArtifact>()
  for (const artifact of artifacts) {
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
  }

  return Object.freeze({
    resolve(id: string) {
      return byId.get(id)
    },
    list() {
      return artifacts
    },
  })
}

function validateApp(value: unknown): value is NeemApp<any, any> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as NeemApp).kind === 'string' &&
      'definition' in value &&
      typeof (value as NeemApp).createRuntime === 'function',
  )
}

async function stopRuntime() {
  if (runtime && started) {
    await runtime.stop()
  }
  started = false
}

async function stopAndExit() {
  try {
    await stopRuntime()
    postMessage({ type: 'stopped' })
    port.close()
  } catch (error) {
    reportError(error, 'runtime')
    process.exit(1)
  }
}

process.on('uncaughtException', (error) => {
  reportError(error, 'runtime')
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  reportError(error, 'runtime')
  process.exit(1)
})

port.on('message', (message: NeemAppWorkerParentMessage) => {
  if (message?.type === 'stop') {
    void stopAndExit()
  }
})

async function main() {
  let app: NeemApp<any, any>

  try {
    const module = await import(pathToFileURL(workerData.appArtifact.file).href)
    app = module.default
    if (!validateApp(app)) {
      throw new Error('App entry default export does not satisfy NeemApp')
    }
    runtime = await app.createRuntime({
      mode: workerData.mode,
      appName: workerData.appName,
      threadIndex: workerData.threadIndex,
      threadOptions: workerData.threadOptions,
      definition: app.definition,
      artifact: workerData.appArtifact,
      artifacts: createArtifactRegistry(workerData.artifacts),
    })
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
