import { parentPort, workerData as rawWorkerData } from 'node:worker_threads'

import type { WorkerUpdate } from '@nmtjs/neem/internal/build/updates'
import type { NeemRuntimeWorker } from '@nmtjs/neem/internal/shared/types'
import type { PatchGlobal } from '@nmtjs/neem/internal/worker/patch-globals'
import type { PatchClientResult } from '@nmtjs/neem/internal/worker/protocol'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { isNeemRuntimeWorker } from '@nmtjs/neem'
import {
  childLogger,
  resolveManifestLogger,
  runtimeLabel,
} from '@nmtjs/neem/internal/logger'
import { importDefault, normalizeError } from '@nmtjs/neem/internal/utils'
import { importPatch } from '@nmtjs/neem/internal/worker/patch-import'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'

import type {
  ThreadWorkerData,
  WorkerPatchResult,
} from '../internal/protocol.ts'
import { hostSettings } from '../internal/config.ts'
import { attempt, Deadline } from '../internal/lifetime.ts'
import { ThreadRpcs } from '../internal/protocol.ts'
import { WorkerExit } from '../internal/worker-exit.ts'
import { WorkerRuntime } from './runtime.ts'

const LABEL = 'Neem runtime'
const data = rawWorkerData as ThreadWorkerData
const patchGlobal = globalThis as PatchGlobal
const exit = new WorkerExit(parentPort, () => data.port.close())
let patches = 0

const runtime = new WorkerRuntime({
  mode: data.mode,
  onFinished: (error) => {
    exit.reportFatal(error, 'runtime', LABEL)
    void exit.exit(1)
  },
  // The host gets a summary; the full failure exists only here.
  onStartError: (error, origin) =>
    exit.logger?.error(new Error(`${LABEL} ${origin} error`, { cause: error })),
  onCleanupError: (error) =>
    exit.logger?.warn(
      new Error('Neem runtime cleanup after start error failed', {
        cause: error,
      }),
    ),
})

const load = Effect.gen(function* () {
  const logger = childLogger(
    yield* attempt(() =>
      resolveManifestLogger(data.logger, {
        mode: data.mode,
        outDir: data.outDir,
      }),
    ),
    runtimeLabel(data.runtimeName, data.name),
  )
  exit.logger = logger
  logger.trace(
    { artifactId: data.artifact.id, file: data.artifact.file },
    'Neem runtime worker initializing',
  )
  // The DevEngine prelude reads these while the artifact evaluates.
  patchGlobal.__neem_patch_client_id__ = data.patchClientId
  patchGlobal.__neem_patch_guard__ = () => runtime.refusal()
  patchGlobal.__neem_accept_worker__ = acceptWorker
  const worker = yield* attempt(() =>
    importDefault<NeemRuntimeWorker>(data.artifact.file),
  )
  if (!isNeemRuntimeWorker(worker)) {
    return yield* Effect.fail(
      new Error(
        `Runtime worker file [${data.artifact.file}] default export must be a marked runtime worker produced by defineRuntimeWorker`,
      ),
    )
  }
  const context = {
    mode: data.mode,
    name: data.name,
    data: data.data,
    logger,
    definition: worker.definition,
    port: data.port,
  }
  return { worker, context }
})

// Called by the patch client once it disposed the running generation's
// modules and re-ran the worker definition: every failure here leaves no
// generation serving.
async function acceptWorker(next: unknown): Promise<void> {
  if (!isNeemRuntimeWorker(next)) {
    throw new Error(
      'Updated worker default export is not a marked runtime worker',
    )
  }
  await Effect.runPromise(runtime.replace(next))
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
      ? importPatch(url)
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
    if (result.outcome === 'applied' && update.type === 'Patch') patches++
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

const stop = (timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = yield* Deadline.make(timeoutMs)
    exit.logger?.trace('Stopping Neem runtime worker')
    const errors = yield* runtime.stop(deadline)
    if (errors.length > 0) {
      for (const error of errors) exit.reportFatal(error, 'runtime', LABEL)
      return yield* Effect.promise(() => exit.exit(1, deadline.remaining()))
    }
    exit.logger?.trace('Neem runtime worker stopped')
    return yield* Effect.promise(() => exit.exit(0, deadline.remaining()))
  })

const handlers = ThreadRpcs.toLayer({
  start: () => Deferred.await(runtime.ready),
  patch: ({ update, url }) =>
    runtime.patch(Effect.promise(() => applyUpdate(update, url))),
  stop: ({ timeoutMs }) => stop(timeoutMs),
})

exit.installCrashHandlers(LABEL)
// Started before the server listens, so the artifact loads while the host
// is still sending its first request.
Effect.runFork(
  Effect.gen(function* () {
    yield* runtime.boot(load)
    const settings = yield* hostSettings(process.env)
    yield* Layer.launch(
      RpcServer.layer(ThreadRpcs, {
        disableTracing: !settings.tracing,
        // A defect fails its own request, not every request of the client.
        disableFatalDefects: true,
      }).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolWorkerRunner),
        Layer.provide(NodeWorkerRunner.layer),
      ),
    )
  }),
)
