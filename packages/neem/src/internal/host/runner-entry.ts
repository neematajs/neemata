import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type {
  NeemRuntimeHost,
  NeemRuntimeHostFactory,
  NeemRuntimeThreadHandle,
} from '../../public/runtime.ts'
import type {
  HostRunnerData,
  HostRunnerRequest,
  HostRunnerResponse,
} from './runner-protocol.ts'
import { createArtifactRegistry } from '../manifest/artifacts.ts'
import {
  childLogger,
  resolveManifestLogger,
  runtimeLabel,
} from '../shared/logger.ts'
import {
  deserializeError,
  importDefault,
  normalizeError,
  serializeError,
} from '../shared/utils.ts'

if (!parentPort) {
  throw new Error('Neem host runner requires a parent port')
}

const port = parentPort
const data = rawWorkerData as HostRunnerData
let host: NeemRuntimeHost | undefined
let logger: Logger | undefined
let currentThreads: readonly NeemRuntimeThreadHandle[] = []

function post(message: HostRunnerResponse): void {
  port.postMessage(message)
}

async function initialize(): Promise<void> {
  logger = childLogger(
    await resolveManifestLogger(data.logger, {
      mode: data.mode,
      outDir: data.outDir,
    }),
    runtimeLabel(data.runtimeName, 'host'),
  )
  logger.trace(
    { artifactId: data.hostArtifact.id, file: data.hostArtifact.file },
    'Neem host initializing',
  )
  const factory = await importDefault<NeemRuntimeHostFactory>(
    data.hostArtifact.file,
  )
  host = await factory({
    mode: data.mode,
    name: data.runtimeName,
    options: data.options,
    logger,
    artifact: data.artifact,
    hostArtifact: data.hostArtifact,
    artifacts: createArtifactRegistry(data.artifacts).scope({
      type: 'runtime',
      name: data.runtimeName,
    }),
    defaultThreads: data.defaultThreads,
  })
  logger.trace('Neem host initialized')
  post({ type: 'ready' })
}

async function handle(request: HostRunnerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'plan':
        logger?.trace('Calling Neem host plan')
        post({
          id: request.id,
          type: 'result',
          data: { plan: await host?.plan?.() },
        })
        return
      case 'start':
        currentThreads = request.threads
        logger?.trace(
          {
            threads: request.threads.length,
            upstreams: request.upstreams.length,
          },
          'Calling Neem host start',
        )
        await host?.start?.({
          threads: request.threads,
          upstreams: request.upstreams,
        })
        post({ id: request.id, type: 'result' })
        return
      case 'stop':
        logger?.trace(
          { threads: currentThreads.length },
          'Calling Neem host stop',
        )
        await host?.stop?.({ threads: currentThreads })
        currentThreads = []
        post({ id: request.id, type: 'result' })
        return
      case 'fail':
        logger?.trace('Calling Neem host fail')
        await host?.fail?.({
          error: deserializeError(request.error),
          threads: currentThreads,
        })
        post({ id: request.id, type: 'result' })
        return
      case 'shutdown':
        logger?.trace('Neem host shutting down')
        post({ id: request.id, type: 'result' })
        port.close()
        return
    }
  } catch (error) {
    post({ id: request.id, type: 'error', error: serializeError(error) })
  }
}

port.on('message', (message: HostRunnerRequest) => {
  void handle(message)
})

process.on('uncaughtException', (error) => {
  logger?.error(new Error('Neem host uncaught exception', { cause: error }))
  post({ type: 'failure', error: serializeError(error) })
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  const normalized = normalizeError(error)
  logger?.error(
    new Error('Neem host unhandled rejection', { cause: normalized }),
  )
  post({ type: 'failure', error: serializeError(normalized) })
  process.exit(1)
})

initialize().catch((error) => {
  post({ type: 'failure', error: serializeError(error) })
  process.exit(1)
})
