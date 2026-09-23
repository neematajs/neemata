import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveRuntimeProjectFiles } from '../../src/internal/build/declarations.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('resolveRuntimeProjectFiles', () => {
  it('excludes negated globs without requiring declarations in matched folders', async () => {
    const dir = await createProject([
      'src/runtimes/api/neem.runtime.ts',
      'src/runtimes/experimental/draft/neem.runtime.ts',
      'src/runtimes/experimental/notes/readme.md',
    ])

    const matches = resolveRuntimeProjectFiles(resolve(dir, 'neem.config.ts'), [
      './src/runtimes/**/neem.runtime.ts',
      '!./src/runtimes/experimental/**',
    ])

    expect(matches.map((match) => match.file)).toEqual([
      resolve(dir, 'src/runtimes/api/neem.runtime.ts'),
    ])
  })

  it('excludes a folder and its declaration file from file and folder matches', async () => {
    const dir = await createProject([
      'runtimes/api/neem.runtime.ts',
      'runtimes/legacy/neem.runtime.ts',
    ])
    const configFile = resolve(dir, 'neem.config.ts')

    for (const include of ['./runtimes/*', './runtimes/*/neem.runtime.ts']) {
      const matches = resolveRuntimeProjectFiles(configFile, [
        include,
        '!./runtimes/legacy',
      ])
      expect(matches.map((match) => match.file)).toEqual([
        resolve(dir, 'runtimes/api/neem.runtime.ts'),
      ])
    }
  })
})

async function createProject(files: readonly string[]): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-declarations-'))
  tempDirs.push(dir)
  for (const file of files) {
    await mkdir(resolve(dir, file, '..'), { recursive: true })
    await writeFile(resolve(dir, file), '')
  }
  return dir
}
