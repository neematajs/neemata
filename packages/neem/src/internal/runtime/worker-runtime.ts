import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function resolveRuntimeWorkerEntry(): URL {
  const sourceEntry = new URL(
    '../../../dist/internal/runtime/worker-entry.js',
    import.meta.url,
  )
  const distEntry = new URL('./worker-entry.js', import.meta.url)
  const entry = isSourceInternalFile(import.meta.url) ? sourceEntry : distEntry

  if (!existsSync(fileURLToPath(entry))) {
    throw new Error(
      `Neem runtime worker entry was not found at [${fileURLToPath(entry)}]`,
    )
  }

  return entry
}

function isSourceInternalFile(url: string): boolean {
  const file = fileURLToPath(url)
  return file.includes('/src/internal/')
}
