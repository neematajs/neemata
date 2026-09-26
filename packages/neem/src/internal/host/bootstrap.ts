import type { Logger } from 'pino'
import { createFuture } from '@nmtjs/common'

import type { NeemMode, NeemRuntimeServerHealth } from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import { flushLogger, resolveManifestLogger } from '../logger.ts'
import {
  assertManifestFilesExist,
  readManifest,
  selectManifestRuntimes,
} from '../manifest/manifest.ts'
import { createRuntimeSnapshot } from '../manifest/snapshot.ts'
import { normalizeError } from '../utils.ts'
import { HostController } from './controller.ts'
import {
  isOperationAborted,
  OperationScope,
  resolveLifecycle,
} from './lifecycle.ts'

export type LoadRuntimeSnapshotOptions = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  env?: NodeJS.ProcessEnv
  runtimes?: readonly string[]
  // Dev sessions resolve the logger once per host generation and reuse it for
  // runtime reloads, so a reload does not re-import the logger module.
  logger?: Logger
}

export async function loadRuntimeSnapshot(
  options: LoadRuntimeSnapshotOptions,
): Promise<RuntimeSnapshot> {
  const { mode, outDir, manifestFile } = options
  const manifest = selectManifestRuntimes(
    await readManifest(manifestFile),
    options.runtimes,
  )
  await assertManifestFilesExist(outDir, manifest)
  const logger =
    options.logger ??
    (await resolveManifestLogger(manifest.config.logger, { mode, outDir }))

  return createRuntimeSnapshot({
    mode,
    outDir,
    env: options.env,
    manifest,
    manifestFile,
    logger,
  })
}

export type RunHostOptions = {
  signal: AbortSignal
  onReady?: (health: NeemRuntimeServerHealth) => void
  onFailure?: (error: Error) => void
  onStopped?: () => void
}

// Production host lifecycle shared by `neem start` and standalone start.js:
// run until the signal aborts or a worker failure brings the host down. A
// failed shutdown rejects, so the process exits non-zero.
export async function runHostUntilClosed(
  snapshot: RuntimeSnapshot,
  options: RunHostOptions,
): Promise<void> {
  const { signal } = options
  if (signal.aborted) return

  const closed = createFuture<void>()
  // A failure during startup rejects before anyone awaits `closed`.
  closed.promise.catch(() => {})
  const controller = new HostController({
    snapshot,
    failOnWorkerError: true,
    onFailure(error) {
      options.onFailure?.(error)
      closed.reject(error)
    },
  })

  // Created by the first stop; the logger flush after it spends what is left.
  let stopScope: OperationScope | undefined
  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= (async () => {
      stopScope = OperationScope.withTimeout(
        resolveLifecycle(snapshot.config.lifecycle).stopTimeout,
      )
      await controller.stop(stopScope)
      options.onStopped?.()
    })())
  const onAbort = () => {
    void stop().then(
      () => closed.resolve(),
      (error) => closed.reject(normalizeError(error)),
    )
  }
  signal.addEventListener('abort', onAbort, { once: true })

  let failed = false
  try {
    try {
      await controller.start()
      if (!signal.aborted) options.onReady?.(controller.getHealth())
    } catch (error) {
      // A signal stopped the start; `closed` carries the stop's outcome.
      if (!isOperationAborted(error)) throw error
    }
    await closed.promise
  } catch (error) {
    failed = true
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      // The first error wins: after a failure, a failing cleanup stop must not
      // replace it; otherwise the stop's own failure is the result.
      if (failed) await stop().catch(() => undefined)
      else await stop()
    } finally {
      // A failed run ends in process.exit (the CLI) or an unhandled rejection
      // (start.js), either of which drops what async log destinations buffer.
      await flushLogger(snapshot.logger, stopScope?.remaining() ?? 0)
    }
  }
}
