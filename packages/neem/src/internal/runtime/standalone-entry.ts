import { fileURLToPath } from 'node:url'

import { startNeem } from '../commands/start.ts'

export type NeemStandaloneStartOptions = { runtimes?: readonly string[] }

export async function startStandalone(
  options: NeemStandaloneStartOptions = {},
): Promise<void> {
  const outDir = fileURLToPath(new URL('../', import.meta.url))
  const controller = new AbortController()
  const abort = () => controller.abort()

  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)

  try {
    const host = await startNeem({
      cwd: outDir,
      outDir: '.',
      runtimes: options.runtimes,
      runtimeWorkerEntry: new URL('./worker-entry.js', import.meta.url),
      signal: controller.signal,
    })

    await host.closed
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}
