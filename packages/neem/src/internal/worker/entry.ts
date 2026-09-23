import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from 'pino'

import type {
  NeemRuntime,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '../../shared/types.ts'
import type { WorkerUpdate } from '../build/updates.ts'
import type { PatchGlobal } from './patch-globals.ts'
import type {
  PatchClientResult,
  RuntimeWorkerData,
  WorkerCommands,
  WorkerErrorOrigin,
  WorkerEvent,
  WorkerPatchResult,
} from './protocol.ts'
import { isNeemRuntimeWorker } from '../../public/worker.ts'
import { childLogger, resolveManifestLogger, runtimeLabel } from '../logger.ts'
import { serveRpc } from '../rpc.ts'
import { parseRuntimeStartResult } from '../schemas/runtime.ts'
import { importDefault, normalizeError, serializeError } from '../utils.ts'
import { WORKER_SERIAL_COMMANDS } from './protocol.ts'
import { ReloadableRuntime } from './reloadable-runtime.ts'

const workerData = rawWorkerData as RuntimeWorkerData

const patchGlobal = globalThis as PatchGlobal
let currentWorker: NeemRuntimeWorker | undefined
let patches = 0
let runtime: NeemRuntime | undefined
let logger: Logger | undefined
// stopping memoizes runtime cleanup, which a failed start also needs;
// stopRequested records that the host asked for it, so exits are not failures.
let stopping: Promise<void> | undefined
let stopRequested: Promise<void> | undefined

const server = serveRpc<WorkerCommands, WorkerEvent>(
  parentPort,
  'Neem runtime worker entry',
  {
    'patch-update': ({ update, url }) => applyUpdate(update, url),
    stop: async (_params, { exitAfterReply }) => {
      await stopOnRequest()
      exitAfterReply(0)
    },
  },
  {
    serial: WORKER_SERIAL_COMMANDS,
    onClose: () => workerData.port.close(),
  },
)

function reportError(value: unknown, origin: WorkerErrorOrigin): void {
  // This thread is the only place the real value still exists, so it is
  // logged here in full; the parent only receives a rendered summary.
  if (value instanceof Error) {
    logger?.error(new Error(`Neem runtime ${origin} error`, { cause: value }))
  } else {
    logger?.error({ err: value }, `Neem runtime ${origin} error`)
  }
  server.post({ type: 'error', data: { ...serializeError(value), origin } })
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
  // The DevEngine prelude reads the client id during artifact evaluation.
  patchGlobal.__neem_patch_client_id__ = data.patchClientId
  patchGlobal.__neem_patch_guard__ = refusePatch
  patchGlobal.__neem_accept_worker__ = acceptWorker
  const worker = await importDefault<NeemRuntimeWorker<unknown, unknown>>(
    data.artifact.file,
  )
  if (!isNeemRuntimeWorker(worker)) {
    throw new Error(
      `Runtime worker file [${data.artifact.file}] default export must be a marked runtime worker produced by defineRuntimeWorker`,
    )
  }

  currentWorker = worker
  const context: NeemRuntimeWorkerContext = {
    mode: data.mode,
    name: data.name,
    data: data.data,
    logger,
    definition: worker.definition,
    port: data.port,
  }
  const created =
    data.mode === 'development'
      ? ReloadableRuntime.create(worker, context)
      : worker.createRuntime(context)
  logger.trace('Neem runtime worker initialized')
  return created
}

// Refusals that depend only on the running generation. The patch client asks
// before it disposes anything, so a refused patch leaves that generation
// serving and the runtime restarts around it.
function refusePatch(): string | undefined {
  if (currentWorker?.reload === 'thread') {
    return "Worker requires reload: 'thread'"
  }
  if (!(runtime instanceof ReloadableRuntime)) {
    return 'Worker generation reload is only available in development'
  }
  return runtime.refusal()?.message
}

// Runs once the patch client has disposed the running generation's modules
// and re-executed the worker definition, so every failure here leaves no
// generation serving; recovery restarts the runtime.
async function acceptWorker(next: unknown): Promise<void> {
  if (!isNeemRuntimeWorker(next)) {
    throw new Error(
      'Updated worker default export is not a marked runtime worker',
    )
  }
  if (next.reload === 'thread') {
    throw new Error("Updated worker requires reload: 'thread'")
  }
  if (!(runtime instanceof ReloadableRuntime)) {
    throw new Error('Worker generation reload is only available in development')
  }
  const reload = await runtime.apply(next)
  if (reload.outcome !== 'applied') throw reload.error
  currentWorker = next
}

async function applyUpdate(
  update: WorkerUpdate,
  url: string | undefined,
): Promise<WorkerPatchResult> {
  const client = patchGlobal.__neem_patches__
  // The client decides whether the patch file loads at all; a skipped import
  // leaves the patch undelivered.
  const load = () =>
    url
      ? import(url)
      : Promise.reject(new Error('Patch update carries no file URL'))
  let result: PatchClientResult
  try {
    result = client
      ? await client.apply(update, load)
      : {
          outcome: 'rejected',
          delivered: false,
          reason: 'Worker artifact was not built with Rolldown DevEngine',
        }
    if (result.outcome === 'applied' && update.type === 'Patch') {
      patches++
    }
  } catch (error) {
    // The client classifies every failure after it starts touching modules;
    // one escaping it happened before that.
    result = {
      outcome: 'rejected',
      delivered: false,
      reason: normalizeError(error).message,
    }
  }
  return { ...result, patches }
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

// Resolves once the runtime stopped; a failed stop is reported and exits the
// thread instead, so the stop reply never claims a clean stop.
function stopOnRequest(): Promise<void> {
  return (stopRequested ??= (async () => {
    try {
      await stopRuntime()
    } catch (error) {
      reportError(error, 'runtime')
      await server.exit(1)
    }
  })())
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
  await server.exit(1)
}

process.on('uncaughtException', (error) => {
  reportError(error, 'runtime')
  void server.exit(1)
})

process.on('unhandledRejection', (error) => {
  reportError(error, 'runtime')
  void server.exit(1)
})

// Started before main so a stop that arrives during bootstrap can await it.
const initialization = createRuntime(workerData)

async function main(): Promise<void> {
  try {
    runtime = await initialization
  } catch (error) {
    if (stopRequested) return
    reportError(error, 'bootstrap')
    await server.exit(1)
    return
  }

  if (stopRequested) return
  try {
    logger?.trace('Starting Neem runtime worker')
    const result = await runtime.start()
    if (stopRequested) return
    const upstreams = parseRuntimeStartResult(result)
    logger?.trace({ upstreams: upstreams.length }, 'Neem runtime worker ready')
    server.post({ type: 'ready', data: { upstreams } })
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
    await server.exit(1)
  }
}

void main()
