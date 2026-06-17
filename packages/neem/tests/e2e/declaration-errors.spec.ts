import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import { createNeemFixture, spawnNeem } from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem runtime declaration error diagnostics', () => {
  it('fails duplicate runtime names with a duplicate name diagnostic', async () => {
    const result = await buildExpectingFailure('duplicate-runtime-name')

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toContain('Duplicate runtime name [api]')
    expect(result.output).toContain('duplicate.runtime.ts')
  }, 60_000)

  it('fails when a runtime has neither explicit nor conventional planner', async () => {
    const result = await buildExpectingFailure('missing-planner')

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toContain('has no resolved planner entry')
    expect(result.output).toContain('api.runtime.ts')
  }, 60_000)

  it('fails when a runtime has a planner but no worker or custom host', async () => {
    const result = await buildExpectingFailure('planner-only-no-worker-host')

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toContain(
      'must provide a worker or a custom host entry',
    )
    expect(result.output).toContain('api.runtime.ts')
  }, 60_000)
})

async function buildExpectingFailure(
  config: string,
): Promise<{
  exit: { code: number | null; signal: string | null }
  output: string
}> {
  const fixture = await createNeemFixture({ config })
  fixtures.push(fixture)
  const neem = spawnNeem([
    'build',
    '--config',
    fixture.configFile,
    '--outDir',
    fixture.outDir,
  ])
  spawned.push(neem)
  const exit = await neem.waitForExit()
  return { exit, output: [neem.stdout(), neem.stderr()].join('\n') }
}
