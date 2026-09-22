import { describe, expect, it } from 'vitest'

import { createNeemFixture, spawnNeem } from './support/e2e.ts'

describe('Neem dev environment files', () => {
  it.each([
    ['missing.env', 'MISSING_ENV_FILE'],
    ['', '--env-files requires non-empty file paths'],
    ['.env,', '--env-files requires non-empty file paths'],
  ])('rejects %j before starting services', async (path, message) => {
    const fixture = await createNeemFixture()
    const neem = spawnNeem(['dev', '--no-cache', `--env-files=${path}`], {
      cwd: fixture.dir,
    })

    expect((await neem.waitForExit()).code).not.toBe(0)
    expect(neem.stderr()).toContain(message)
    expect(neem.events()).toEqual([])
  })
})
