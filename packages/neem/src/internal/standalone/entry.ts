import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRuntimeSnapshot, runHostUntilClosed } from '../host/bootstrap.ts'
import { MANIFEST_FILE } from '../manifest/manifest.ts'

export type StandaloneStartOptions = {
  env?: NodeJS.ProcessEnv
  runtimes?: readonly string[]
}

export async function startStandalone(
  options: StandaloneStartOptions = {},
): Promise<void> {
  const outDir = fileURLToPath(new URL('../', import.meta.url))
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
