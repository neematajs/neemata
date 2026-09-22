import { cp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import { createTempDir } from '../support/temp.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  runNeem,
  spawnNode,
  waitFor,
} from './support/e2e.ts'

describe('Neem production portability', () => {
  it('starts a copied production build after original source fixtures are removed', async () => {
    const { copiedOutDir, fixture } = await buildCopiedFixture({
      config: 'plugin',
    })

    const node = spawnNode([resolve(copiedOutDir, 'start.js')], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    const events = await waitFor(
      async () => {
        const current = await readRuntimeEvents(fixture.eventsFile)
        const hasRuntimeStart = current.some(
          (event) => event.event === 'runtime-start',
        )
        const hasSetup = current.some((event) => event.event === 'plugin-setup')
        const hasInitialize = current.some(
          (event) => event.event === 'plugin-initialize',
        )
        return hasRuntimeStart && hasSetup && hasInitialize ? current : false
      },
      30_000,
      () => formatSpawnedOutput(node),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'runtime-start', name: 'api:0' }),
        expect.objectContaining({
          event: 'plugin-setup',
          mode: 'production',
          name: 'fixture-plugin',
          options: { fixture: 'plugin' },
        }),
        expect.objectContaining({
          event: 'plugin-initialize',
          mode: 'production',
        }),
      ]),
    )

    await node.stop()
  }, 60_000)

  it('starts a copied per-runtime production wrapper', async () => {
    const { copiedOutDir, fixture } = await buildCopiedFixture({
      config: 'plugin',
    })

    const node = spawnNode([resolve(copiedOutDir, 'runtimes/api/start.js')], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    const events = await waitFor(
      async () => {
        const current = await readRuntimeEvents(fixture.eventsFile)
        return current.some((event) => event.event === 'runtime-start')
          ? current
          : false
      },
      30_000,
      () => formatSpawnedOutput(node),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'runtime-start', name: 'api:0' }),
        expect.objectContaining({
          event: 'runtime-create',
          mode: 'production',
          name: 'api:0',
        }),
      ]),
    )

    await node.stop()
  }, 60_000)

  it('starts a copied host-only production wrapper', async () => {
    const { copiedOutDir, fixture } = await buildCopiedFixture({
      config: 'host-only',
    })

    const node = spawnNode([resolve(copiedOutDir, 'start.js')], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    const events = await waitFor(
      async () => {
        const current = await readRuntimeEvents(fixture.eventsFile)
        return current.some((event) => event.event === 'host-only-start')
          ? current
          : false
      },
      30_000,
      () => formatSpawnedOutput(node),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'host-only-setup',
          mode: 'production',
          name: 'scheduler',
          options: { fixture: 'host-only' },
        }),
        expect.objectContaining({ event: 'host-only-start', threads: 0 }),
      ]),
    )

    await node.stop()
  }, 60_000)
})

async function buildCopiedFixture(options: { config: string }): Promise<{
  copiedOutDir: string
  fixture: Awaited<ReturnType<typeof createNeemFixture>>
}> {
  const fixture = await createNeemFixture({ config: options.config })
  const portableRoot = await createTempDir(
    'portable-',
    resolve(import.meta.dirname, '.tmp'),
  )
  const copiedOutDir = resolve(portableRoot, 'dist')

  await runNeem([
    'build',
    '--config',
    fixture.configFile,
    '--outDir',
    fixture.outDir,
  ])
  await cp(fixture.outDir, copiedOutDir, { recursive: true })
  await writeFile(
    fixture.configFile,
    "throw new Error('copied production start must not import source config')\n",
  )
  await rm(fixture.fixtureDir, { recursive: true, force: true })

  return { copiedOutDir, fixture }
}

function formatSpawnedOutput(neem: SpawnedNeem): string {
  return [`stdout:\n${neem.stdout()}`, `stderr:\n${neem.stderr()}`].join('\n')
}
