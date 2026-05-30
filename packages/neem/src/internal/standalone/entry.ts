import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFuture } from '@nmtjs/common'

import { HostController } from '../host/controller.ts'
import {
  MANIFEST_FILE,
  readManifest,
  selectManifestRuntimes,
} from '../manifest/manifest.ts'
import { createRuntimeSnapshot } from '../manifest/snapshot.ts'
import { resolveManifestLogger } from '../shared/logger.ts'
import { normalizeError } from '../shared/utils.ts'

export type StandaloneStartOptions = { runtimes?: readonly string[] }

export async function startStandalone(
  options: StandaloneStartOptions = {},
): Promise<void> {
  const outDir = fileURLToPath(new URL('../', import.meta.url))
  const manifestFile = resolve(outDir, MANIFEST_FILE)
  const manifest = selectManifestRuntimes(
    await readManifest(manifestFile),
    options.runtimes,
  )
  const logger = await resolveManifestLogger(manifest.config.logger, {
    mode: 'production',
    outDir,
  })
  const closed = createFuture<void>()
  const controller = new HostController({
    snapshot: createRuntimeSnapshot({
      mode: 'production',
      outDir,
      manifest,
      manifestFile,
      logger,
    }),
    failOnWorkerError: true,
    onFailure(error) {
      closed.reject(error)
    },
  })

  const stop = () => {
    void controller.stop().then(
      () => closed.resolve(),
      (error) => closed.reject(normalizeError(error)),
    )
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    await controller.start()
    await closed.promise
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await controller.stop().catch(() => undefined)
  }
}
