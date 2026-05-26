import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createNeemFixture,
  readRuntimeEvents,
  runNeem,
  spawnNeem,
  spawnNode,
  wait,
  waitFor,
} from '../support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []

describe('neem lifecycle e2e', () => {
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  })

  it('starts and stops built output through the CLI', async () => {
    const fixture = await createFixture()
    await buildFixture(fixture)

    const neem = spawnNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      expect(
        neem.events().filter((event) => event.event === 'hook:worker:ready'),
      ).toHaveLength(2)
      expect(
        neem.events().filter((event) => event.event === 'hook:runtime:ready'),
      ).toHaveLength(1)

      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })

      const events = await readRuntimeEvents(fixture.eventsFile)
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'stop', name: 'api:0' }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'stop', name: 'api:1' }),
      )
    } catch (error) {
      neem.child.kill('SIGKILL')
      throw error
    }
  }, 20_000)

  it('starts only selected runtime through the CLI', async () => {
    const fixture = await createFixture('generic-runtime.config.ts')
    await buildFixture(fixture)

    const neem = spawnNeem(['start', '--outDir', fixture.outDir, 'api'], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      expect(
        neem
          .events()
          .filter((event) => event.event === 'hook:runtime:ready')
          .map((event) => event.name),
      ).toEqual(['api'])

      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })

      const events = await readRuntimeEvents(fixture.eventsFile)
      expect(events.some((event) => event.name === 'jobs')).toBe(false)
      expect(events.some((event) => event.event === 'host-setup')).toBe(false)
    } catch (error) {
      neem.child.kill('SIGKILL')
      throw error
    }
  }, 20_000)

  it('starts built output through standalone start entry', async () => {
    const fixture = await createFixture()
    await buildFixture(fixture)

    const neem = spawnNode([resolve(fixture.outDir, 'start.js')], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      expect(neem.events()).toContainEqual(
        expect.objectContaining({ event: 'standalone:start' }),
      )
      expect(
        neem.events().filter((event) => event.event === 'hook:worker:ready'),
      ).toHaveLength(2)

      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })
      expect(await readRuntimeEvents(fixture.eventsFile)).toContainEqual(
        expect.objectContaining({ event: 'stop', name: 'api:0' }),
      )
    } catch (error) {
      neem.child.kill('SIGKILL')
      throw error
    }
  }, 20_000)

  it('starts selected runtime through per-runtime standalone entry', async () => {
    const fixture = await createFixture('generic-runtime.config.ts')
    await buildFixture(fixture)

    const neem = spawnNode([resolve(fixture.outDir, 'runtimes/api/start.js')], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      expect(
        neem
          .events()
          .filter((event) => event.event === 'hook:runtime:ready')
          .map((event) => event.name),
      ).toEqual(['api'])

      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })

      const events = await readRuntimeEvents(fixture.eventsFile)
      expect(events.some((event) => event.name === 'jobs')).toBe(false)
      expect(events.some((event) => event.event === 'host-setup')).toBe(false)
    } catch (error) {
      neem.child.kill('SIGKILL')
      throw error
    }
  }, 20_000)

  it('fails built output on worker bootstrap errors', async () => {
    const fixture = await createFixture('runtime-bootstrap-fail.config.ts')
    await buildFixture(fixture)

    const neem = spawnNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.events()).toContainEqual(
      expect.objectContaining({
        event: 'hook:worker:fail',
        error: expect.objectContaining({
          message: 'fixture bootstrap import failure',
        }),
      }),
    )
    expect(neem.events()).toContainEqual(
      expect.objectContaining({ event: 'hook:server:fail' }),
    )
  }, 20_000)

  it('fails built output on runtime start errors and stops started peers', async () => {
    const fixture = await createFixture('runtime-fail-start.config.ts')
    await buildFixture(fixture)

    const neem = spawnNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.events()).toContainEqual(
      expect.objectContaining({ event: 'hook:worker:fail', name: 'api:1' }),
    )
    expect(neem.events()).toContainEqual(
      expect.objectContaining({ event: 'hook:server:fail' }),
    )

    const events = await readRuntimeEvents(fixture.eventsFile)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', name: 'api:0' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', name: 'api:1' }),
    )
  }, 20_000)

  it('treats post-ready worker failures as fatal in production', async () => {
    const fixture = await createFixture('runtime-fail-after-start.config.ts')
    await buildFixture(fixture)

    const neem = spawnNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    await neem.waitForEvent(
      (event) => event.event === 'hook:worker:fail' && event.name === 'api:1',
    )
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.events()).toContainEqual(
      expect.objectContaining({ event: 'hook:runtime:fail', name: 'api' }),
    )
  }, 20_000)

  it('reloads changed runtime artifacts in dev without restarting process', async () => {
    const fixture = await createFixture()
    const neem = spawnNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      const appSource = await readFile(fixture.appFile, 'utf8')
      await writeFile(
        fixture.appFile,
        appSource.replace(
          "definition: { fixture: 'runtime-app' }",
          "definition: { fixture: 'runtime-dev-e2e' }",
        ),
      )

      await neem.waitForEvent(
        (event) => event.event === 'hook:runtime:reload',
        15_000,
      )
      const events = await waitFor(async () => {
        const events = await readRuntimeEvents(fixture.eventsFile)
        return events.some(
          (event) => event.definition?.fixture === 'runtime-dev-e2e',
        )
          ? events
          : false
      })
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'stop', name: 'api:0' }),
      )

      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })
    } catch (error) {
      neem.child.kill('SIGKILL')
      throw error
    }
  }, 30_000)

  it('keeps existing dev runtime alive while rebuild is broken', async () => {
    const fixture = await createFixture()
    const neem = spawnNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    try {
      await neem.waitForEvent((event) => event.event === 'hook:server:ready')
      const initialReadyCount = neem
        .events()
        .filter((event) => event.event === 'hook:worker:ready').length

      const appSource = await readFile(fixture.appFile, 'utf8')
      await writeFile(fixture.appFile, 'const = ;\n')
      await wait(1_000)

      expect(
        neem.events().filter((event) => event.event === 'hook:worker:stop'),
      ).toHaveLength(0)
      expect(
        neem.events().filter((event) => event.event === 'hook:worker:ready'),
      ).toHaveLength(initialReadyCount)

      await writeFile(fixture.appFile, appSource)
      await neem.waitForEvent(
        (event) => event.event === 'hook:runtime:reload',
        15_000,
      )

      const exit = await neem.stop()
      expect(exit).toEqual({ code: 0, signal: null })
    } catch (error) {
      neem.child.kill('SIGKILL')
      throw error
    }
  }, 30_000)
})

async function createFixture(config?: string) {
  const fixture = await createNeemFixture({ config })
  fixtures.push(fixture)
  return fixture
}

async function buildFixture(fixture: { configFile: string; outDir: string }) {
  await runNeem([
    'build',
    '--config',
    fixture.configFile,
    '--outDir',
    fixture.outDir,
  ])
}
