import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type {
  NeemRuntimeHost,
  NeemRuntimeHostFactory,
  NeemRuntimePlan,
  NeemRuntimePlanner,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type {
  HostRunnerData,
  HostRunnerRequest,
  HostRunnerResponse,
} from './runner-protocol.ts'
import {
  isNeemRuntimeHostFactory,
  isNeemRuntimePlanner,
} from '../../public/runtime.ts'
import { childLogger, resolveManifestLogger, runtimeLabel } from '../logger.ts'
import { importDefault, normalizeError, serializeError } from '../utils.ts'

if (!parentPort) {
  throw new Error('Neem host runner requires a parent port')
}

const port = parentPort
const data = rawWorkerData as HostRunnerData
let host: NeemRuntimeHost | undefined
let logger: Logger | undefined
let plannerOptions: unknown
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
    {
      hostArtifactId: data.hostArtifact.id,
      hostFile: data.hostArtifact.file,
      plannerArtifactId: data.plannerArtifact.id,
      plannerFile: data.plannerArtifact.file,
    },
    'Neem host runner initialized',
  )
  post({ type: 'ready' })
}

async function callPlanner(): Promise<NeemRuntimePlan> {
  if (!logger) throw new Error('Neem host runner logger is not initialized')
  const planner = await importDefault<NeemRuntimePlanner>(
    data.plannerArtifact.file,
  )
  if (!isNeemRuntimePlanner(planner)) {
    throw new Error(
      `Runtime planner file [${data.plannerArtifact.file}] default export must be a marked runtime planner produced by defineRuntimePlanner or a package planner helper`,
    )
  }

  const plan = await planner({
    mode: data.mode,
    name: data.runtimeName,
    logger,
  })
  if (!plan || !('workers' in plan)) {
    throw new Error(
      `Runtime planner file [${data.plannerArtifact.file}] must return workers`,
    )
  }
  plannerOptions = plan.options
  return { workers: plan.workers }
}

async function initializeHost(
  threads: readonly NeemRuntimeThreadHandle[],
): Promise<void> {
  if (!logger) throw new Error('Neem host runner logger is not initialized')
  const factory = await importDefault<NeemRuntimeHostFactory>(
    data.hostArtifact.file,
  )
  if (!isNeemRuntimeHostFactory(factory)) {
    throw new Error(
      `Runtime host file [${data.hostArtifact.file}] default export must be a marked runtime host factory produced by defineRuntimeHost`,
    )
  }

  currentThreads = threads
  host = await factory({
    mode: data.mode,
    name: data.runtimeName,
    logger,
    threads,
    options: plannerOptions,
  })
  await host.start?.()
}

async function handle(request: HostRunnerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'plan':
        logger?.trace('Calling Neem runtime planner')
        post({
          id: request.id,
          type: 'result',
          data: { plan: await callPlanner() },
        })
        return
      case 'start':
        logger?.trace(
          { threads: request.threads.length },
          'Calling Neem runtime host start',
        )
        await initializeHost(request.threads)
        post({ id: request.id, type: 'result' })
        return
      case 'stop':
        logger?.trace(
          { threads: currentThreads.length },
          'Calling Neem runtime host stop',
        )
        await host?.stop?.()
        host = undefined
        currentThreads = []
        post({ id: request.id, type: 'result' })
        return
      case 'shutdown':
        logger?.trace('Neem host runner shutting down')
        post({ id: request.id, type: 'result' })
        port.close()
        await new Promise<void>((resolve) => setImmediate(resolve))
        process.exit(0)
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
