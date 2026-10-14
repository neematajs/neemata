import { expect, it } from 'vitest'

import { spawnNeem } from '../../../neem/tests/e2e/support/e2e.ts'

it('prints command help without loading an application', async () => {
  const process = spawnNeem(['dev', '--help'])
  expect(await process.waitForExit()).toEqual({ code: 0, signal: null })
  expect(process.stdout()).toContain('neem-effect dev')
  expect(process.stdout()).toContain('--no-cache')
  expect(process.stdout()).toContain('--env-files')
})

it('prints the package version', async () => {
  const process = spawnNeem(['--version'])
  expect(await process.waitForExit()).toEqual({ code: 0, signal: null })
  expect(process.stdout()).toMatch(/neem-effect v\d+\.\d+\.\d+/)
})

it.each(['bash', 'zsh', 'fish', 'sh'])(
  'generates %s completion without loading an application',
  async (shell) => {
    const process = spawnNeem(['--completions', shell])
    expect(await process.waitForExit(), process.stderr()).toEqual({
      code: 0,
      signal: null,
    })
    expect(process.stdout()).toContain('neem-effect')
  },
)
