import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import { NEEM_MANIFEST_FILE } from '../../../packages/neem/src/internal/build/manifest.ts'
import { devNeem } from '../../../packages/neem/src/internal/commands/dev.ts'
import { spawnNeem } from '../support/e2e.ts'

const fixturesDir = resolve(import.meta.dirname, '../fixtures')
const tempRoot = resolve(import.meta.dirname, '../.tmp-dev')
const tempDirs: string[] = []
const previousEventsFile = process.env.NEEM_RUNTIME_EVENTS_FILE
const previousPluginEventsFile = process.env.NEEM_PLUGIN_EVENTS_FILE

describe('neem dev', () => {
  afterEach(async () => {
    if (previousEventsFile === undefined) {
      delete process.env.NEEM_RUNTIME_EVENTS_FILE
    } else {
      process.env.NEEM_RUNTIME_EVENTS_FILE = previousEventsFile
    }
    if (previousPluginEventsFile === undefined) {
      delete process.env.NEEM_PLUGIN_EVENTS_FILE
    } else {
      process.env.NEEM_PLUGIN_EVENTS_FILE = previousPluginEventsFile
    }

    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('starts runtime workers in development mode from watched build output', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      expect(host.getLifecycle().state).toBe('running')
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        runtimes: [
          { name: 'api', pool: { state: 'ready', size: 2, ready: 2 } },
        ],
        proxy: { enabled: false, running: false },
      })

      const manifest = await readManifest(fixture.outDir)
      expect(manifest.config.runtimes.api).toMatchObject({
        threads: expect.any(Array),
      })
      await expectFile(
        resolve(fixture.outDir, manifest.runtimes!.api!.entry.file),
      )

      const createEvents = await waitForEvents(
        fixture.eventsFile,
        (events) =>
          events.filter((event) => event.event === 'create').length >= 2,
      )
      expect(createEvents[0]).toMatchObject({
        mode: 'development',
        logger: true,
      })
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('starts only selected runtimes in development mode', async () => {
    const fixture = await createFixtureCopy('generic-runtime.config.ts')
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
      runtimes: ['api'],
    })

    try {
      await host.ready
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        runtimeNames: ['api'],
        runtimes: [
          { name: 'api', pool: { state: 'ready', size: 2, ready: 2 } },
        ],
      })

      const manifest = await readManifest(fixture.outDir)
      expect(Object.keys(manifest.runtimes ?? {})).toEqual(['api'])
      expect(Object.keys(manifest.config.runtimes)).toEqual(['api'])
      await expectFile(
        resolve(fixture.outDir, manifest.runtimes!.api!.entry.file),
      )

      const events = await readEvents(fixture.eventsFile)
      expect(events.some((event) => event.name === 'jobs')).toBe(false)
      expect(events.some((event) => event.event === 'host-setup')).toBe(false)
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('restarts workers after runtime source rebuild and keeps old workers on rebuild errors', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      let events = await readEvents(fixture.eventsFile)
      const initialCreateCount = countEvents(events, 'create')
      const appSource = await readFile(fixture.appFile, 'utf8')
      await writeFile(fixture.appFile, 'const = ;\n')
      await wait(1_000)

      events = await readEvents(fixture.eventsFile)
      expect(events.filter((event) => event.event === 'stop')).toHaveLength(0)
      expect(host.getHealth()).toMatchObject({ state: 'running', ready: true })

      await writeFile(
        fixture.appFile,
        appSource.replace(
          "definition: { fixture: 'runtime-app' }",
          "definition: { fixture: 'runtime-dev-app' }",
        ),
      )

      events = await waitForEvents(
        fixture.eventsFile,
        (next) => countEvents(next, 'create') >= initialCreateCount + 2,
      )
      expect(
        events.filter((event) => event.event === 'stop').length,
      ).toBeGreaterThan(0)
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        runtimes: [
          { name: 'api', pool: { state: 'ready', size: 2, ready: 2 } },
        ],
      })
    } finally {
      await host.stop()
      await host.closed
    }
  }, 15_000)

  it('coalesces rapid runtime source rebuilds and applies the latest artifact', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      const initialEvents = await readEvents(fixture.eventsFile)
      const initialCreateCount = countEvents(initialEvents, 'create')
      const appSource = await readFile(fixture.appFile, 'utf8')
      const definition = "definition: { fixture: 'runtime-app' }"

      await writeFile(
        fixture.appFile,
        appSource.replace(
          definition,
          "definition: { fixture: 'runtime-app-a' }",
        ),
      )
      await writeFile(
        fixture.appFile,
        appSource.replace(
          definition,
          "definition: { fixture: 'runtime-app-b' }",
        ),
      )
      await writeFile(
        fixture.appFile,
        appSource.replace(
          definition,
          "definition: { fixture: 'runtime-app-c' }",
        ),
      )

      const events = await waitFor(async () => {
        const events = await readEvents(fixture.eventsFile)
        const creates = events.filter((event) => event.event === 'create')
        return creates.length >= initialCreateCount + 2 &&
          creates.some((event) => event.definition?.fixture === 'runtime-app-c')
          ? events
          : false
      })

      await wait(300)
      const settledEvents = await readEvents(fixture.eventsFile)
      expect(countEvents(settledEvents, 'create')).toBe(
        countEvents(events, 'create'),
      )
      expect(host.getLifecycle().state).toBe('running')
    } finally {
      await host.stop()
      await host.closed
    }
  }, 15_000)

  it('reloads plugin hooks after plugin entry rebuilds', async () => {
    const fixture = await createFixtureCopy('plugin.config.ts')
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile
    process.env.NEEM_PLUGIN_EVENTS_FILE = fixture.pluginEventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      await waitForEvents(
        fixture.pluginEventsFile,
        (events) =>
          events.filter((event) => event.event === 'plugin:server:ready')
            .length >= 2,
      )

      const source = await readFile(fixture.pluginHooksFile, 'utf8')
      await writeFile(
        fixture.pluginHooksFile,
        source.replace(
          "const pluginVersion = 'one'",
          "const pluginVersion = 'two'",
        ),
      )

      const events = await waitForEvents(
        fixture.pluginEventsFile,
        (events) =>
          events.filter(
            (event) =>
              event.event === 'plugin:server:reload' && event.version === 'two',
          ).length >= 2,
      )
      const reloads = events.filter(
        (event) => event.event === 'plugin:server:reload',
      )
      expect(reloads.map((event) => event.version)).toEqual(['two', 'two'])
      expect(reloads.map((event) => event.options)).toEqual([
        { label: 'first' },
        { label: 'second' },
      ])
    } finally {
      await host.stop()
      await host.closed
    }
  }, 15_000)

  it('restarts the dev child process after config changes', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile
    const neem = spawnNeem([
      'dev',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      const initialEvents = await readEvents(fixture.eventsFile)
      const initialCreateCount = countEvents(initialEvents, 'create')
      const source = await readFile(fixture.configFile, 'utf8')
      await writeFile(
        fixture.configFile,
        source.replace("label: 'one'", "label: 'eins'"),
      )

      await neem.waitForEvent(
        () =>
          neem.events().filter((event) => event.event === 'hook:server:ready')
            .length >= 2,
      )
      const events = await waitFor(async () => {
        const events = await readEvents(fixture.eventsFile)
        return countEvents(events, 'create') >= initialCreateCount + 2 &&
          events.some((event) => event.data?.label === 'eins')
          ? events
          : false
      }, 10_000)
      expect(events.some((event) => event.data?.label === 'eins')).toBe(true)
    } finally {
      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })
    }
  }, 15_000)

  it('runs dev through the CLI and stops on SIGTERM', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile
    const neem = spawnNeem([
      'dev',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    try {
      await waitFor(async () => {
        await access(resolve(fixture.outDir, NEEM_MANIFEST_FILE))
        return true
      })
    } finally {
      const exit = await neem.stop()

      expect(exit).toEqual({ code: 0, signal: null })
    }
  }, 15_000)
})

async function createFixtureCopy(config = 'runtime.config.ts') {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(resolve(tempRoot, 'neem-dev-'))
  tempDirs.push(dir)

  const fixtureDir = resolve(dir, 'fixtures')
  await cp(fixturesDir, fixtureDir, { recursive: true })

  return {
    dir,
    fixtureDir,
    configFile: resolve(fixtureDir, config),
    appFile: resolve(fixtureDir, 'runtime-app.ts'),
    pluginHooksFile: resolve(fixtureDir, 'plugin-hooks.ts'),
    outDir: resolve(dir, '.neem'),
    eventsFile: resolve(dir, 'events.jsonl'),
    pluginEventsFile: resolve(dir, 'plugin-events.jsonl'),
  }
}

async function readManifest(outDir: string): Promise<NeemBuildManifest> {
  return JSON.parse(
    await readFile(resolve(outDir, NEEM_MANIFEST_FILE), 'utf8'),
  ) as NeemBuildManifest
}

async function readEvents(file: string): Promise<RuntimeEvent[]> {
  const content = await readFile(file, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent)
}

async function waitForEvents(
  file: string,
  predicate: (events: RuntimeEvent[]) => boolean,
): Promise<RuntimeEvent[]> {
  return waitFor(async () => {
    const events = await readEvents(file)
    return predicate(events) ? events : false
  })
}

async function waitFor<T>(
  fn: () => Promise<T | false>,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fn()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await wait(50)
  }

  if (lastError) throw lastError
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function countEvents(events: readonly RuntimeEvent[], event: string): number {
  return events.filter((item) => item.event === event).length
}

async function expectFile(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined()
}

type RuntimeEvent = {
  event: string
  name?: string
  mode?: string
  version?: string
  data?: Record<string, unknown>
  options?: Record<string, unknown>
  definition?: { fixture?: string }
}
