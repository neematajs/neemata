import type { Logger } from 'pino'
import { createFuture } from '@nmtjs/common'

import type { NeemMode, NeemRuntimeServerHealth } from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import { resolveManifestLogger } from '../logger.ts'
import {
  assertManifestFilesExist,
  readManifest,
  selectManifestRuntimes,
} from '../manifest/manifest.ts'
import { createRuntimeSnapshot } from '../manifest/snapshot.ts'
import { normalizeError } from '../utils.ts'
import { HostController } from './controller.ts'

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
// run until the signal aborts or a worker failure brings the host down.
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

  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= controller.stop().then(() => options.onStopped?.()))
  const onAbort = () => {
    void stop().then(
      () => closed.resolve(),
      (error) => closed.reject(normalizeError(error)),
    )
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await controller.start()
    if (!signal.aborted) options.onReady?.(controller.getHealth())
    await closed.promise
  } finally {
    signal.removeEventListener('abort', onAbort)
    await stop().catch(() => undefined)
  }
}
