import { cp, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SpawnedNeem } from '../../neem/tests/e2e/support/e2e.ts'
import {
  editWorkerFile,
  spawnNeem,
  waitFor,
  waitForPatchClients,
} from '../../neem/tests/e2e/support/e2e.ts'
import { createTempDir } from '../../neem/tests/support/temp.ts'

type RuntimeEvent = { event: string; [key: string]: unknown }

const runtimeEventPrefix = 'NEEM_RUNTIME_EVENT '

describe.each(['Promise', 'Effect'])('Neem %s runtime restart', (mode) => {
  it('rotates worker generations without rebuilding planner topology', async () => {
    const fixture = await createFixture(mode)
    const neem = spawnNeem([
      'dev',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const initial = await waitForGeneration('v1', 1, neem)
    const threads = new Set(initial.map((event) => event.threadId))
    expect(threads.size).toBe(2)
    // Edits before registration replace the threads instead of patching them.
    await waitForPatchClients(neem, { threads: 2, runtimeName: 'workflows' })

    for (const generation of [2, 3]) {
      const previous = `'v${generation - 1}'`
      const marker = `v${generation}`
      // Wait for the watcher to acknowledge each edit. An edit missed while
      // its watch is restarting must not look like a worker rotation failure.
      await editWorkerFile(neem, fixture.markerFile, (content) => {
        expect(content).toContain(previous)
        return content.replace(previous, `'${marker}'`)
      })
      const starts = await waitForGeneration(marker, generation, neem)
      await waitFor(
        () => {
          const patches = neem
            .events()
            .filter((event) => event.event === 'runtime:patch-applied')
          return patches.length >= generation - 1
        },
        30_000,
        () => diagnostics(neem),
      )

      expect(starts).toHaveLength(2)
      expect(new Set(starts.map((event) => event.threadId))).toEqual(threads)
      const events = readRuntimeEvents(neem)
      for (const start of starts) {
        const stopped = events.findIndex(
          (event) =>
            event.event === 'workflows:stop' &&
            event.threadId === start.threadId &&
            event.generation === generation - 1,
        )
        const started = events.findIndex(
          (event) =>
            event.event === 'workflows:start' &&
            event.threadId === start.threadId &&
            event.generation === generation,
        )
        expect(stopped).toBeGreaterThanOrEqual(0)
        expect(stopped).toBeLessThan(started)
      }
    }
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(0)
  }, 60_000)

  it('omits DevEngine instrumentation from production worker artifacts', async () => {
    const fixture = await createFixture(mode)
    const neem = spawnNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const exit = await neem.waitForExit()
    expect(exit.code, diagnostics(neem)).toBe(0)

    // The shared Neem bootstrap keeps its receive path in all modes; only
    // the application worker artifact receives DevEngine instrumentation.
    const files = await listJavaScriptFiles(
      resolve(fixture.outDir, 'runtime/workflows/worker'),
    )
    const output = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n')
    for (const marker of [
      '__rolldown_runtime__',
      'registerFactory',
      '__neem_accept_worker__',
    ]) {
      expect(output.includes(marker), marker).toBe(false)
    }
  }, 60_000)
})

async function createFixture(mode: string) {
  const tempRoot = resolve(import.meta.dirname, '.tmp')
  const dir = await createTempDir('restart-', tempRoot)
  const fixtureDir = resolve(dir, 'fixture')
  await cp(resolve(import.meta.dirname, 'fixtures/restart'), fixtureDir, {
    recursive: true,
  })

  if (mode === 'Effect') {
    await cp(
      resolve(fixtureDir, 'effect.worker.ts'),
      resolve(fixtureDir, 'workflows.worker.ts'),
    )
  }

  const configFile = resolve(fixtureDir, 'neem.config.ts')
  const markerFile = resolve(fixtureDir, 'marker.ts')
  const outDir = resolve(dir, '.neem')
  return { configFile, markerFile, outDir }
}

async function waitForGeneration(
  marker: string,
  generation: number,
  neem: SpawnedNeem,
) {
  return waitFor(
    () => {
      const events = readRuntimeEvents(neem).filter(
        (event) =>
          event.event === 'workflows:start' &&
          event.marker === marker &&
          event.generation === generation,
      )
      return events.length >= 2 ? events : undefined
    },
    30_000,
    () => diagnostics(neem),
  )
}

async function listJavaScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listJavaScriptFiles(file)))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file)
  }
  return files
}

function readRuntimeEvents(neem: SpawnedNeem): RuntimeEvent[] {
  return neem
    .stdout()
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.startsWith(runtimeEventPrefix))
    .map(
      (line) =>
        JSON.parse(line.slice(runtimeEventPrefix.length)) as RuntimeEvent,
    )
}

function diagnostics(neem: SpawnedNeem) {
  return `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}\nprobes:\n${JSON.stringify(neem.events())}`
}
