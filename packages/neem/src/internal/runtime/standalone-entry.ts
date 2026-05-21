import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startNeem } from '../commands/start.ts'

const outDir = dirname(fileURLToPath(import.meta.url))
const controller = new AbortController()

const abort = () => controller.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)

try {
  const host = await startNeem({
    cwd: outDir,
    outDir: '.',
    runtimeWorkerEntry: new URL('./runtime/worker-entry.js', import.meta.url),
    signal: controller.signal,
  })

  await host.closed
} finally {
  process.off('SIGINT', abort)
  process.off('SIGTERM', abort)
}
