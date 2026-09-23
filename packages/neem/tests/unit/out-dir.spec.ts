import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  resolveBuildOutDir,
  resolveDevOutDir,
  resolveStartOutDir,
} from '../../src/internal/commands/out-dir.ts'
import { createTempDir } from '../support/temp.ts'

const cwd = '/workspace'
const configDir = '/workspace/app/sub'
const defaultConfig = resolve(configDir, 'neem.config.ts')
const otherConfig = resolve(configDir, 'neem.other.config.ts')

describe('resolveBuildOutDir', () => {
  it('resolves config outDir from the config directory, not cwd', () => {
    expect(
      resolveBuildOutDir({
        cwd,
        configFile: defaultConfig,
        config: { outDir: 'build' },
      }),
    ).toBe('/workspace/app/sub/build')
  })

  it('defaults to dist next to the config', () => {
    expect(
      resolveBuildOutDir({ cwd, configFile: defaultConfig, config: {} }),
    ).toBe('/workspace/app/sub/dist')
  })

  it('resolves an explicit outDir from cwd, overriding config outDir', () => {
    expect(
      resolveBuildOutDir({
        cwd,
        configFile: defaultConfig,
        config: { outDir: 'build' },
        outDir: 'out',
      }),
    ).toBe('/workspace/out')
  })
})

describe('resolveDevOutDir', () => {
  it('separates configs sharing a directory', () => {
    expect(resolveDevOutDir({ cwd, configFile: defaultConfig })).toBe(
      '/workspace/app/sub/.neem/neem.config',
    )
    expect(resolveDevOutDir({ cwd, configFile: otherConfig })).toBe(
      '/workspace/app/sub/.neem/neem.other.config',
    )
  })

  it('stays outside the default build output', () => {
    const dev = resolveDevOutDir({ cwd, configFile: defaultConfig })
    const build = resolveBuildOutDir({
      cwd,
      configFile: defaultConfig,
      config: {},
    })
    expect(dev.startsWith(`${build}/`)).toBe(false)
  })

  it('resolves an explicit outDir from cwd', () => {
    expect(
      resolveDevOutDir({ cwd, configFile: defaultConfig, outDir: '.dev' }),
    ).toBe('/workspace/.dev')
  })
})

describe('resolveStartOutDir', () => {
  it('defaults to dist in cwd without evaluating a config', async () => {
    await expect(resolveStartOutDir({ cwd })).resolves.toBe('/workspace/dist')
  })

  it('uses the outDir of each config sharing a directory', async () => {
    const dir = await createTempDir('neem-out-dir-')
    const sub = resolve(dir, 'sub')
    await mkdir(sub)
    await writeFile(
      resolve(sub, 'neem.config.ts'),
      'export default { runtimes: [] }\n',
    )
    await writeFile(
      resolve(sub, 'neem.other.config.ts'),
      "export default { outDir: 'other-dist', runtimes: [] }\n",
    )

    await expect(
      resolveStartOutDir({ cwd: dir, config: 'sub/neem.config.ts' }),
    ).resolves.toBe(resolve(sub, 'dist'))
    await expect(
      resolveStartOutDir({ cwd: dir, config: 'sub/neem.other.config.ts' }),
    ).resolves.toBe(resolve(sub, 'other-dist'))
  })

  it('does not evaluate the config when outDir is explicit', async () => {
    await expect(
      resolveStartOutDir({
        cwd,
        config: 'missing/neem.config.ts',
        outDir: 'out',
      }),
    ).resolves.toBe('/workspace/out')
  })
})
