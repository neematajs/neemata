import { resolve } from 'node:path'

import { loadRuntimeSnapshot, runHostUntilClosed } from '../host/bootstrap.ts'
import { MANIFEST_FILE } from '../manifest/manifest.ts'
import { toFilePath } from '../utils.ts'

export type StandaloneStartOptions = {
  // The build output root holding the manifest. The generated launchers pass
  // it relative to themselves: this module's own location says nothing about
  // it once chunking or a copied layout moves it.
  outDir: string | URL
  env?: NodeJS.ProcessEnv
  runtimes?: readonly string[]
}

export async function startStandalone(
  options: StandaloneStartOptions,
): Promise<void> {
  const outDir = toFilePath(options.outDir)
  const snapshot = await loadRuntimeSnapshot({
    mode: 'production',
    outDir,
    manifestFile: resolve(outDir, MANIFEST_FILE),
    env: options.env,
    runtimes: options.runtimes,
  })
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
