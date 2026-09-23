import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { Logger } from 'pino'

import type {
  NeemRuntime,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '../../shared/types.ts'
import type {
  ParentMessage,
  PatchClientResult,
  RuntimeWorkerData,
  WorkerErrorOrigin,
  WorkerMessage,
} from './protocol.ts'
import { isNeemRuntimeWorker } from '../../public/worker.ts'
import { childLogger, resolveManifestLogger, runtimeLabel } from '../logger.ts'
import { parseRuntimeStartResult } from '../schemas/runtime.ts'
import { importDefault, normalizeError, serializeError } from '../utils.ts'
import { ReloadableRuntime } from './reloadable-runtime.ts'

if (!parentPort) {
  throw new Error('Neem runtime worker entry requires a parent port')
}

const port = parentPort
const workerData = rawWorkerData as RuntimeWorkerData

type PatchGlobal = typeof globalThis & {
  __neem_patch_client_id__?: string
  __neem_accept_worker__?: (worker: unknown) => Promise<void>
  __neem_patches__?: {
    apply: (
      update: Extract<ParentMessage, { type: 'patch-update' }>['update'],
      url?: string,
    ) => Promise<PatchClientResult>
  }
}

const patchGlobal = globalThis as PatchGlobal
let currentWorker: NeemRuntimeWorker | undefined
let patches = 0
let runtime: NeemRuntime | undefined
let logger: Logger | undefined
// stopping memoizes runtime cleanup, which a failed start also needs;
// stopRequested records that the host asked for it, so exits are not failures.
let stopping: Promise<void> | undefined
let stopRequested = false
let exiting: Promise<void> | undefined

function postMessage(message: WorkerMessage): void {
  port.postMessage(message)
}

// Every exit path closes the ports and yields once after its last message so
// the parent receives that message before the exit event.
function exitAfterFlush(code: number, message?: WorkerMessage): Promise<void> {
  return (exiting ??= (async () => {
    if (message) postMessage(message)
    workerData.port.close()
    port.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.exit(code)
  })())
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
  // The DevEngine prelude reads the client id during artifact evaluation.
  patchGlobal.__neem_patch_client_id__ = data.patchClientId
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

// The injected patch client reports an accept failure as an unavailable
// generation unless the error carries this mark: the running generation was
// never touched and keeps serving, so the patch is only rejected.
function generationIntact(error: Error): Error {
  return Object.assign(error, { neemGenerationIntact: true })
}

async function acceptWorker(next: unknown): Promise<void> {
  if (!isNeemRuntimeWorker(next)) {
    throw generationIntact(
      new Error('Updated worker default export is not a marked runtime worker'),
    )
  }
  if (currentWorker?.reload === 'thread' || next.reload === 'thread') {
    throw generationIntact(new Error("Worker requires reload: 'thread'"))
  }
  if (!(runtime instanceof ReloadableRuntime)) {
    throw generationIntact(
      new Error('Worker generation reload is only available in development'),
    )
  }
  const reload = await runtime.apply(next)
  if (reload.outcome === 'rejected') throw generationIntact(reload.error)
  if (reload.outcome === 'unavailable') throw reload.error
  currentWorker = next
}

async function applyUpdate(
  message: Extract<ParentMessage, { type: 'patch-update' }>,
): Promise<void> {
  const client = patchGlobal.__neem_patches__
  let result: PatchClientResult
  try {
    result = client
      ? await client.apply(message.update, message.url)
      : {
          outcome: 'rejected',
          delivered: false,
          reason: 'Worker artifact was not built with Rolldown DevEngine',
        }
    if (result.outcome === 'applied' && message.update.type === 'Patch') {
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
  postMessage({ id: message.id, type: 'result', data: { ...result, patches } })
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
  } catch (error) {
    reportError(error, 'runtime')
    await exitAfterFlush(1)
    return
  }
  await exitAfterFlush(0, { type: 'stopped' })
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
  await exitAfterFlush(1)
}

port.on('message', (message: ParentMessage) => {
  if (message?.type === 'stop') void stopAndExit()
  if (message?.type === 'patch-update') void applyUpdate(message)
})

process.on('uncaughtException', (error) => {
  reportError(error, 'runtime')
  void exitAfterFlush(1)
})

process.on('unhandledRejection', (error) => {
  reportError(error, 'runtime')
  void exitAfterFlush(1)
})

// Started before main so a stop that arrives during bootstrap can await it.
const initialization = createRuntime(workerData)

async function main(): Promise<void> {
  try {
    runtime = await initialization
  } catch (error) {
    if (stopRequested) return
    reportError(error, 'bootstrap')
    await exitAfterFlush(1)
    return
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
    await exitAfterFlush(1)
  }
}

void main()
