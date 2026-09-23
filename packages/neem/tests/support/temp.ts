import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { onTestFinished } from 'vitest'

export async function createTempDir(prefix: string, root = tmpdir()) {
  await mkdir(root, { recursive: true })
  const created = mkdtemp(resolve(root, prefix))

  // Register before fixture setup can fail. Later resource hooks run first,
  // so workers and processes release these files before their removal.
  onTestFinished(async () => {
    const dir = await created
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      console.error(
        `[neem:test] Failed to clean up temporary directory: ${dir}`,
        error,
      )
      throw error
    }
  })

  const dir = await created
  console.log(`[neem:test] Created temporary directory: ${dir}`)
  return dir
}
