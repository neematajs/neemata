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

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/manifest.ts'
import { main } from '../../../packages/neem/src/cli.ts'
import { devNeem } from '../../../packages/neem/src/internal/dev.ts'
import { NEEM_MANIFEST_FILE } from '../../../packages/neem/src/internal/manifest.ts'

const fixturesDir = resolve(import.meta.dirname, '../fixtures')
const tempRoot = resolve(import.meta.dirname, '../node_modules/.tmp')
const tempDirs: string[] = []
const previousEventsFile = process.env.NEEM_RUNTIME_EVENTS_FILE

describe('neem dev', () => {
  afterEach(async () => {
    if (previousEventsFile === undefined) {
      delete process.env.NEEM_RUNTIME_EVENTS_FILE
    } else {
      process.env.NEEM_RUNTIME_EVENTS_FILE = previousEventsFile
    }

    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('starts app workers in development mode from watched build output', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      expect(host.getLifecycle().state).toBe('running')

      const manifest = await readManifest(fixture.outDir)
      expect(manifest.plugins).toEqual([])
      expect(manifest.config.file).toMatch(
        /^config\/entry\/runtime\.config-[^.]+\.js$/,
      )
      await expectFile(resolve(fixture.outDir, manifest.config.file))
      await expectFile(resolve(fixture.outDir, manifest.apps.api.entry.file))

      const configCode = await readFile(
        resolve(fixture.outDir, manifest.config.file),
        'utf8',
      )
      expect(configCode).toContain('import("./runtime-app.ts")')
      expect(configCode).toContain('import("./jobs.plugin.ts")')

      const createEvents = await waitForEvents(
        fixture.eventsFile,
        (events) =>
          events.filter((event) => event.event === 'create').length >= 2,
      )
      expect(createEvents[0]).toMatchObject({ mode: 'development' })
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('updates hashed config artifact and restarts workers after config changes', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      const initialManifest = await readManifest(fixture.outDir)
      const source = await readFile(fixture.configFile, 'utf8')
      await writeFile(
        fixture.configFile,
        source.replace("label: 'one'", "label: 'uno'"),
      )

      await waitFor(async () => {
        const manifest = await readManifest(fixture.outDir)
        if (manifest.config.file === initialManifest.config.file) return false
        const events = await readEvents(fixture.eventsFile)
        return events.some(
          (event) =>
            event.event === 'create' && event.threadOptions?.label === 'uno',
        )
      })
      expect(host.getLifecycle().state).toBe('running')
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('restarts workers after app source rebuild and keeps old workers on rebuild errors', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile

    const host = await devNeem({
      config: fixture.configFile,
      outDir: fixture.outDir,
    })

    try {
      await host.ready
      const appSource = await readFile(fixture.appFile, 'utf8')
      await writeFile(fixture.appFile, 'const = ;\n')
      await wait(300)

      let events = await readEvents(fixture.eventsFile)
      expect(events.filter((event) => event.event === 'stop')).toHaveLength(0)

      await writeFile(
        fixture.appFile,
        appSource.replace(
          "kind: 'runtime-fixture'",
          "kind: 'runtime-dev-fixture'",
        ),
      )

      events = await waitForEvents(
        fixture.eventsFile,
        (next) => next.filter((event) => event.event === 'create').length >= 4,
      )
      expect(
        events.filter((event) => event.event === 'stop').length,
      ).toBeGreaterThan(0)
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('runs dev through the CLI and stops through an abort signal', async () => {
    const fixture = await createFixtureCopy()
    process.env.NEEM_RUNTIME_EVENTS_FILE = fixture.eventsFile
    const controller = new AbortController()

    const running = main(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { signal: controller.signal },
    )

    await waitFor(async () => {
      await access(resolve(fixture.outDir, NEEM_MANIFEST_FILE))
      return true
    })

    controller.abort()
    await expect(running).resolves.toBe(0)
  })
})

async function createFixtureCopy() {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(resolve(tempRoot, 'neem-dev-'))
  tempDirs.push(dir)

  const fixtureDir = resolve(dir, 'fixtures')
  await cp(fixturesDir, fixtureDir, { recursive: true })

  return {
    dir,
    fixtureDir,
    configFile: resolve(fixtureDir, 'runtime.config.ts'),
    appFile: resolve(fixtureDir, 'runtime-app.ts'),
    outDir: resolve(dir, '.neem'),
    eventsFile: resolve(dir, 'events.jsonl'),
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

async function expectFile(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined()
}

type RuntimeEvent = {
  event: string
  mode?: string
  appName?: string
  threadIndex?: number
  threadOptions?: Record<string, unknown>
}
