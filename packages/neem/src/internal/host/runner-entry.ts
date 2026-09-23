import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from 'pino'

import type {
  NeemRuntimeHost,
  NeemRuntimeHostFactory,
  NeemRuntimePlan,
  NeemRuntimePlanner,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type {
  HostRunnerCommands,
  HostRunnerData,
  HostRunnerEvent,
} from './runner-protocol.ts'
import {
  isNeemRuntimeHostFactory,
  isNeemRuntimePlanner,
} from '../../public/runtime.ts'
import { childLogger, resolveManifestLogger, runtimeLabel } from '../logger.ts'
import { serveRpc } from '../rpc.ts'
import { importDefault, normalizeError, serializeError } from '../utils.ts'
import { HOST_RUNNER_SERIAL_COMMANDS } from './runner-protocol.ts'

const data = rawWorkerData as HostRunnerData
let host: NeemRuntimeHost | undefined
// The factory may still be resolving when stop arrives; stop awaits it so the
// host it eventually returns is stopped exactly once.
let creating: Promise<NeemRuntimeHost> | undefined
let stopping: Promise<void> | undefined
let logger: Logger | undefined
let plannerOptions: unknown
let currentThreads: readonly NeemRuntimeThreadHandle[] = []

function closeCurrentThreads(): void {
  for (const thread of currentThreads) thread.port.close()
  currentThreads = []
}

const server = serveRpc<HostRunnerCommands, HostRunnerEvent>(
  parentPort,
  'Neem host runner',
  {
    plan: () => {
      logger?.trace('Calling Neem runtime planner')
      return callPlanner()
    },
    start: ({ threads }) => {
      logger?.trace(
        { threads: threads.length },
        'Calling Neem runtime host start',
      )
      return initializeHost(threads)
    },
    stop: () => {
      logger?.trace(
        { threads: currentThreads.length },
        'Calling Neem runtime host stop',
      )
      return stopHost()
    },
    shutdown: async (_params, { exitAfterReply }) => {
      logger?.trace('Neem host runner shutting down')
      // Without an earlier stop, a host still being created would outlive
      // the runner; an earlier stop that hangs is the parent's to abandon.
      if (!stopping && creating) await stopHost()
      exitAfterReply(0)
    },
  },
  { serial: HOST_RUNNER_SERIAL_COMMANDS, onClose: closeCurrentThreads },
)

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
  server.post({ type: 'ready' })
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
  if (stopping) throw new Error('Neem runtime host stopped before start')

  currentThreads = threads
  const params = {
    mode: data.mode,
    name: data.runtimeName,
    logger,
    threads,
    options: plannerOptions,
  }
  creating = (async () => factory(params))()
  const created = await creating
  if (stopping) throw new Error('Neem runtime host stopped before start')
  host = created
  await created.start?.()
}

function stopHost(): Promise<void> {
  return (stopping ??= (async () => {
    const current = host ?? (await creating?.catch(() => undefined))
    host = undefined
    await current?.stop?.()
    closeCurrentThreads()
  })())
}

process.on('uncaughtException', (error) => {
  logger?.error(new Error('Neem host uncaught exception', { cause: error }))
  void server.exit(1, { type: 'failure', error: serializeError(error) })
})

process.on('unhandledRejection', (error) => {
  const normalized = normalizeError(error)
  logger?.error(
    new Error('Neem host unhandled rejection', { cause: normalized }),
  )
  void server.exit(1, { type: 'failure', error: serializeError(normalized) })
})

initialize().catch((error) => {
  void server.exit(1, { type: 'failure', error: serializeError(error) })
})
