import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createNeemFixture,
  runNeem,
  spawnNode,
  updateFileAtomically,
} from './support/e2e.ts'

it.each(['dev', 'build'])(
  'preserves source-map artifacts and Node error locations in %s',
  async (mode) => {
    const fixture = await createNeemFixture({ config: 'start-failure-cleanup' })
    const bin = resolve(import.meta.dirname, '../../bin/neem.js')
    const args = ['--config', fixture.configFile, '--out-dir', fixture.outDir]
    if (mode === 'build') await runNeem(['build', ...args])
    const logFile = resolve(fixture.dir, 'errors.jsonl')
    const neem = spawnNode(
      [
        '--enable-source-maps',
        ...(mode === 'dev'
          ? [bin, 'dev', '--no-cache', ...args]
          : [resolve(fixture.outDir, 'start.js')]),
      ],
      {
        env: {
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
          NEEM_LOG_EVENTS_FILE: logFile,
        },
      },
    )
    expect((await neem.waitForExit()).code).not.toBe(0)
    const logs = await readFile(logFile, 'utf8')
    expect(logs).toContain('partial startup failure')
    // Bun 1.4.3 reports generated locations for these external Rolldown maps,
    // including before source-text exclusion. Validate artifacts on both
    // runtimes, and Node's stack remapping where it is supported.
    if (!process.versions.bun) {
      expect(logs).toMatch(/partial\.worker\.ts:\d+:\d+/)
      // The bundled infrastructure filename is runtime/worker-entry.js.
      expect(logs).toMatch(/internal\/worker\/entry\.(?:js|ts):\d+:\d+/)
    }

    const infraDir = resolve(fixture.outDir, 'runtime')
    const maps = (await readdir(infraDir)).filter((file) =>
      file.endsWith('.map'),
    )
    expect(maps.length).toBeGreaterThan(0)
    for (const file of maps) {
      const map = JSON.parse(await readFile(resolve(infraDir, file), 'utf8'))
      expect(
        map.sourcesContent?.some((source: string | null) => source !== null),
      ).not.toBe(true)
    }
    const manifest = JSON.parse(
      await readFile(resolve(fixture.outDir, 'neem.manifest.json'), 'utf8'),
    )
    const workerMap = JSON.parse(
      await readFile(
        resolve(fixture.outDir, `${manifest.runtimes.api.worker.file}.map`),
        'utf8',
      ),
    )
    expect(workerMap.sourcesContent.join('\n')).toContain(
      'partial startup failure',
    )
  },
  60_000,
)

// Bun applies its own maps and has no such flags.
describe.skipIf(process.versions.bun)('Node source maps by command', () => {
  it.each([
    { command: 'dev', flags: [], mapped: true },
    { command: 'dev', flags: ['--no-enable-source-maps'], mapped: false },
    { command: 'start', flags: [], mapped: false },
    { command: 'start', flags: ['--enable-source-maps'], mapped: true },
  ])(
    '$command with node flags $flags maps stacks: $mapped',
    async ({ command, flags, mapped }) => {
      const fixture = await createNeemFixture({
        config: 'start-failure-cleanup',
      })
      const bin = resolve(import.meta.dirname, '../../bin/neem.js')
      const args = ['--config', fixture.configFile, '--out-dir', fixture.outDir]
      if (command === 'start') await runNeem(['build', ...args])
      const logFile = resolve(fixture.dir, 'errors.jsonl')
      const neem = spawnNode(
        [
          ...flags,
          bin,
          command,
          ...(command === 'dev' ? ['--no-cache'] : []),
          ...args,
        ],
        { env: { NEEM_LOG_EVENTS_FILE: logFile } },
      )
      expect((await neem.waitForExit()).code).not.toBe(0)
      const logs = await readFile(logFile, 'utf8')
      expect(logs).toContain('partial startup failure')
      const source = /partial\.worker\.ts:\d+:\d+/
      if (mapped) expect(logs).toMatch(source)
      else expect(logs).not.toMatch(source)
    },
    60_000,
  )
})

it('honors explicitly included infrastructure sources', async () => {
  const fixture = await createNeemFixture({ config: 'host-only' })
  await updateFileAtomically(fixture.configFile, (source) =>
    source.replace(
      'defineConfig({',
      "defineConfig({ build: { sourcemapSources: 'include' },",
    ),
  )
  await runNeem([
    'build',
    '--config',
    fixture.configFile,
    '--out-dir',
    fixture.outDir,
  ])
  const map = JSON.parse(
    await readFile(resolve(fixture.outDir, 'runtime/start.js.map'), 'utf8'),
  )
  expect(
    map.sourcesContent.some((source: string | null) => Boolean(source)),
  ).toBe(true)
}, 60_000)
