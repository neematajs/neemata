import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveNeemRuntimeDeclarations,
  resolveRuntimeProjectFiles,
} from '../../src/internal/build/declarations.ts'
import { resolveRequiredBuildEntry } from '../../src/internal/build/resolver.ts'
import { importDefault } from '../../src/internal/utils.ts'
import { defineConfig } from '../../src/public/config.ts'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((dir) => rm(dir, { recursive: true })),
  )
})

describe.each(['cjs', 'cts'])('Neem rejects .%s entries', (extension) => {
  it('rejects a config before evaluating it', async () => {
    const dir = await fixture()
    const file = resolve(dir, `neem.config.${extension}`)
    await writeFile(file, 'throw new Error("CommonJS config was evaluated")')

    await expect(importDefault(file)).rejects.toThrow(
      'is not supported; use an ES module',
    )
  })

  it('does not discover a CommonJS runtime declaration', async () => {
    const dir = await fixture()
    await writeFile(
      resolve(dir, `neem.runtime.${extension}`),
      'module.exports = {}',
    )

    expect(() =>
      resolveRuntimeProjectFiles(resolve(dir, 'neem.config.ts'), [dir]),
    ).toThrow('has no conventional runtime declaration file')
  })

  it('rejects an explicitly selected runtime declaration before evaluating it', async () => {
    const dir = await fixture()
    const file = resolve(dir, `runtime.${extension}`)
    await writeFile(
      file,
      'throw new Error("CommonJS declaration was evaluated")',
    )
    const config = defineConfig({ runtimes: [file] })

    await expect(
      resolveNeemRuntimeDeclarations(resolve(dir, 'neem.config.ts'), config),
    ).rejects.toThrow('is not supported; use an ES module')
  })

  it('rejects runtime artifact entries from paths, file URLs and packages', async () => {
    const dir = await fixture()
    const file = resolve(dir, `worker.${extension}`)
    const pkg = resolve(dir, 'node_modules/fixture')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      resolve(pkg, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: `./worker.${extension}`,
      }),
    )
    await writeFile(resolve(pkg, `worker.${extension}`), 'module.exports = {}')

    for (const entry of [
      `./worker.${extension}`,
      file,
      pathToFileURL(file),
      'fixture',
    ]) {
      expect(() =>
        resolveRequiredBuildEntry(resolve(dir, 'neem.config.ts'), entry),
      ).toThrow('is not supported; use an ES module')
    }
  })
})

async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-esm-'))
  fixtures.push(dir)
  return dir
}
