import { describe, expect, it, vi } from 'vitest'

import { importPatch } from '../../src/internal/worker/patch-import.ts'

const PATCH_URL = 'file:///app/dist/runtime/api/worker/hmr_patch_2.js'

function moduleNotFound(): Error {
  return Object.assign(new Error(`Cannot find module '${PATCH_URL}'`), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

describe('importPatch', () => {
  it('imports the patch again after the resolver reports it missing', async () => {
    const patch = { patched: true }
    const importModule = vi
      .fn<(url: string) => Promise<unknown>>()
      .mockRejectedValueOnce(moduleNotFound())
      .mockResolvedValueOnce(patch)

    await expect(importPatch(PATCH_URL, importModule)).resolves.toBe(patch)
    expect(importModule.mock.calls).toEqual([[PATCH_URL], [PATCH_URL]])
  })

  it('reports a patch that is still missing on the second attempt', async () => {
    const missing = moduleNotFound()
    const importModule = vi
      .fn<(url: string) => Promise<unknown>>()
      .mockRejectedValueOnce(moduleNotFound())
      .mockRejectedValueOnce(missing)

    await expect(importPatch(PATCH_URL, importModule)).rejects.toBe(missing)
    expect(importModule).toHaveBeenCalledTimes(2)
  })

  it('does not import a patch again after it failed to evaluate', async () => {
    const failure = new Error('patch threw while evaluating')
    const importModule = vi
      .fn<(url: string) => Promise<unknown>>()
      .mockRejectedValue(failure)

    await expect(importPatch(PATCH_URL, importModule)).rejects.toBe(failure)
    expect(importModule).toHaveBeenCalledTimes(1)
  })
})
