import { resolve } from 'node:path'

import { MANIFEST_FILE } from '@nmtjs/neem/internal/manifest/manifest'
import { toFilePath } from '@nmtjs/neem/internal/utils'
import * as Effect from 'effect/Effect'

import { runHostUntilClosed } from '../bootstrap.ts'
import { FLAVOR_NAME } from '../internal/flavor-name.ts'
import { loadSnapshot } from '../internal/snapshot.ts'

export type StandaloneStartOptions = {
  // The build output root holding the manifest. Generated launchers pass it
  // relative to themselves: this module's own location says nothing about it
  // once chunking or a copied layout moves it.
  outDir: string | URL
  env?: NodeJS.ProcessEnv
  runtimes?: readonly string[]
}

export async function startStandalone(
  options: StandaloneStartOptions,
): Promise<void> {
  const outDir = toFilePath(options.outDir)
  const snapshot = await Effect.runPromise(
    loadSnapshot({
      flavor: FLAVOR_NAME,
      mode: 'production',
      outDir,
      manifestFile: resolve(outDir, MANIFEST_FILE),
      env: options.env,
      runtimes: options.runtimes,
    }),
  )
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await runHostUntilClosed(snapshot, { signal: controller.signal })
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
