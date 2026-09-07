import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  spawnNeem,
  waitFor,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem dev environment files', () => {
  it.each(['.env.local', '.env.local,.env'])(
    'loads %s before config evaluation and passes values to runtime workers',
    async (paths) => {
      const fixture = await createNeemFixture()
      fixtures.push(fixture)
      await writeFile(
        resolve(fixture.dir, '.env.local'),
        [
          'NEEM_TEST_FILE_VALUE=first',
          'NEEM_TEST_SHELL_VALUE=file',
          'NEEM_TEST_EXPANDED=${NEEM_TEST_FILE_VALUE}-expanded',
          `NEEM_RUNTIME_EVENTS_FILE=${fixture.eventsFile}`,
        ].join('\n'),
      )
      await writeFile(
        resolve(fixture.dir, '.env'),
        'NEEM_TEST_FILE_VALUE=second\nNEEM_TEST_FALLBACK_VALUE=fallback\n',
      )
      const config = await readFile(fixture.configFile, 'utf8')
      await writeFile(
        fixture.configFile,
        `${config}
if (process.env.NEEM_TEST_FILE_VALUE !== 'first' ||
    process.env.NEEM_TEST_SHELL_VALUE !== 'shell' ||
    process.env.NEEM_TEST_EXPANDED !== 'first-expanded' ||
    process.env.NEEM_TEST_FALLBACK_VALUE !== ${paths.includes(',') ? "'fallback'" : 'undefined'}) {
  throw new Error('Incorrect env-file loading before config evaluation')
}
`,
      )
      const neem = spawnNeem(
        [
          'dev',
          '--no-cache',
          '--config',
          fixture.configFile,
          '--outDir',
          fixture.outDir,
          '--env-files',
          paths,
        ],
        {
          cwd: fixture.dir,
          env: {
            NEEM_TEST_FILE_VALUE: undefined,
            NEEM_TEST_SHELL_VALUE: 'shell',
            NEEM_TEST_EXPANDED: undefined,
            NEEM_TEST_FALLBACK_VALUE: undefined,
            NEEM_RUNTIME_EVENTS_FILE: undefined,
          },
        },
      )
      spawned.push(neem)

      await neem.waitForEvent(
        (event) => event.event === 'runtime:ready',
        30_000,
      )
      await waitFor(async () =>
        (await readRuntimeEvents(fixture.eventsFile)).some(
          (event) => event.event === 'start',
        ),
      )
      expect(neem.stdout()).not.toContain('injecting env')
    },
    45_000,
  )

  it('does not load a local .env without the flag', async () => {
    const fixture = await createNeemFixture()
    fixtures.push(fixture)
    await writeFile(
      resolve(fixture.dir, '.env'),
      'NEEM_TEST_FILE_VALUE=unexpected\n',
    )
    const config = await readFile(fixture.configFile, 'utf8')
    await writeFile(
      fixture.configFile,
      `${config}
if (process.env.NEEM_TEST_FILE_VALUE !== undefined) {
  throw new Error('Unexpected automatic env-file loading')
}
`,
    )
    const neem = spawnNeem(
      [
        'dev',
        '--no-cache',
        '--config',
        fixture.configFile,
        '--outDir',
        fixture.outDir,
      ],
      { cwd: fixture.dir, env: { NEEM_TEST_FILE_VALUE: undefined } },
    )
    spawned.push(neem)

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
  }, 45_000)

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
