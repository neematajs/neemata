import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import { createNeemFixture, spawnNeem } from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem dev environment files', () => {
  it.each([
    ['missing.env', 'MISSING_ENV_FILE'],
    ['', '--env-files requires non-empty file paths'],
    ['.env,', '--env-files requires non-empty file paths'],
  ])('rejects %j before starting services', async (path, message) => {
    const fixture = await createNeemFixture()
    fixtures.push(fixture)
    const neem = spawnNeem(['dev', '--no-cache', `--env-files=${path}`], {
      cwd: fixture.dir,
    })
    spawned.push(neem)

    expect((await neem.waitForExit()).code).not.toBe(0)
    expect(neem.stderr()).toContain(message)
    expect(neem.events()).toEqual([])
  })
})
