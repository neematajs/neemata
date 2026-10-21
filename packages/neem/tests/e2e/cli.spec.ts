import { resolve } from 'node:path'

import { expect, it } from 'vitest'

import {
  createNeemFixture,
  runNeem,
  spawnNeem,
  spawnNode,
  writeProductionImportGuard,
} from './support/e2e.ts'

it('starts built output without loading build or development tooling', async () => {
  const fixture = await createNeemFixture({ config: 'generic-runtime' })
  await runNeem([
    'build',
    '--config',
    fixture.configFile,
    '--out-dir',
    fixture.outDir,
  ])
  const guard = resolve(fixture.fixtureDir, 'production-import-guard.mjs')
  await writeProductionImportGuard(guard)
  const neem = spawnNode([
    '--import',
    guard,
    resolve(import.meta.dirname, '../../bin/neem.js'),
    'start',
    '--out-dir',
    fixture.outDir,
  ])
  await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
  expect(await neem.stop()).toEqual({ code: 0, signal: null })
}, 60_000)

it('prints command help without loading an application', async () => {
  const process = spawnNeem(['dev', '--help'])
  expect(await process.waitForExit()).toEqual({ code: 0, signal: null })
  expect(process.stdout()).toContain('neem dev')
  expect(process.stdout()).toContain('--no-cache')
  expect(process.stdout()).toContain('--env-files')
})

it('prints the package version', async () => {
  const process = spawnNeem(['--version'])
  expect(await process.waitForExit()).toEqual({ code: 0, signal: null })
  expect(process.stdout()).toMatch(/neem v\d+\.\d+\.\d+/)
})

it.each(['bash', 'zsh', 'fish', 'sh'])(
  'generates %s completion without loading an application',
  async (shell) => {
    const process = spawnNeem(['--completions', shell])
    expect(await process.waitForExit(), process.stderr()).toEqual({
      code: 0,
      signal: null,
    })
    expect(process.stdout()).toContain('neem')
  },
)
