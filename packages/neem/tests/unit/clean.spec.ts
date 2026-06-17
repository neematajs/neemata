import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { assertSafeNeemOutDir } from '../../src/internal/build/clean.ts'

describe('assertSafeNeemOutDir', () => {
  it('rejects an output directory that contains the config directory', () => {
    const workspace = '/workspace/app'

    expect(() =>
      assertSafeNeemOutDir({
        outDir: workspace,
        configDir: resolve(workspace, 'config'),
      }),
    ).toThrow('Neem output directory must not contain the config directory')
  })

  it('allows output directories outside the config directory', () => {
    expect(() =>
      assertSafeNeemOutDir({
        outDir: '/workspace/app/dist',
        configDir: '/workspace/app/config',
      }),
    ).not.toThrow()
  })
})
