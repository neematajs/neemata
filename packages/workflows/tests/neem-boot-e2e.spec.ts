import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { finished } from 'node:stream/promises'

import { describe, expect, it } from 'vitest'

import type { SpawnedNeem } from '../../neem/tests/e2e/support/e2e.ts'
import {
  runNeem,
  spawnNeem,
  spawnNode,
  waitFor,
} from '../../neem/tests/e2e/support/e2e.ts'
import { createTempDir } from '../../neem/tests/support/temp.ts'

const serverReady = 'NEEM_SERVER_READY\n'

const bootModes = ['production', 'development'] as const

const invalidRegistries = [
  {
    registry: 'undeclared-pool',
    error: 'Execution pools [heavy] named by implementations are not declared',
  },
  {
    registry: 'incomplete',
    error:
      'Tasks [neem-boot.unregistered] referenced by registered workflows have no registered implementation',
  },
]

describe.each(['Promise', 'Effect'])(
  'Neem boot with the %s workflows worker',
  (worker) => {
    it.each(bootModes)(
      'serves a complete registry in %s',
      async (mode) => {
        const neem = await boot(worker, mode)

        // Proves the marker the failure cases rely on is emitted on success.
        await waitFor(
          () => neem.stdout().includes(serverReady),
          30_000,
          () => formatOutput(neem),
        )
        const exit = await neem.stop({ killAfterMs: 5_000 })
        expect(exit, formatOutput(neem)).toEqual({ code: 0, signal: null })
      },
      60_000,
    )

    it.each(
      bootModes.flatMap((mode) =>
        invalidRegistries.map((invalid) => ({ mode, ...invalid })),
      ),
    )(
      'aborts $mode boot for the $registry registry',
      async ({ mode, registry, error }) => {
        const neem = await boot(worker, mode, registry)

        const exit = await neem.waitForExit()
        // A child can exit before its piped output has been read.
        await Promise.all([
          finished(neem.child.stdout!),
          finished(neem.child.stderr!),
        ])
        const output = formatOutput(neem)
        expect(exit.signal, output).toBeNull()
        expect(exit.code, output).not.toBe(0)
        expect(neem.stderr(), output).toContain(error)
        expect(neem.stdout(), output).not.toContain(serverReady)
      },
      60_000,
    )
  },
)

async function boot(
  worker: string,
  mode: (typeof bootModes)[number],
  registry?: string,
): Promise<SpawnedNeem> {
  const fixture = await createFixture(worker)
  const env = registry ? { WORKFLOWS_REGISTRY: registry } : {}
  if (mode === 'development') {
    return spawnNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env },
    )
  }
  await runNeem([
    'build',
    '--config',
    fixture.configFile,
    '--outDir',
    fixture.outDir,
  ])
  return spawnNode([resolve(fixture.outDir, 'start.js')], { env })
}

async function createFixture(worker: string) {
  const tempRoot = resolve(import.meta.dirname, '.tmp')
  const dir = await createTempDir('neem-boot-', tempRoot)
  const fixtureDir = resolve(dir, 'fixture')
  const source = resolve(import.meta.dirname, 'fixtures/neem-boot')
  await cp(source, fixtureDir, { recursive: true })
  if (worker === 'Effect') {
    await cp(
      resolve(fixtureDir, 'effect.worker.ts'),
      resolve(fixtureDir, 'workflows.worker.ts'),
    )
  }
  return {
    configFile: resolve(fixtureDir, 'neem.config.ts'),
    outDir: resolve(dir, '.neem'),
  }
}

function formatOutput(neem: SpawnedNeem) {
  return `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`
}
