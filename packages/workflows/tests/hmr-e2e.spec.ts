import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

type RuntimeEvent = { event: string; [key: string]: unknown }
type SpawnedNeem = ReturnType<typeof spawnNeem>

const runtimeEventPrefix = 'NEEM_RUNTIME_EVENT '
const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe.each(['Promise', 'Effect'])('Neem %s workflows HMR', (mode) => {
  it('rotates worker generations without rebuilding planner topology', async () => {
    const fixture = await createFixture(mode)
    fixtures.push(fixture)
    const neem = spawnNeem([
      'dev',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    spawned.push(neem)

    await waitForGeneration('v1', 1, 2, neem)
    await replaceInFile(fixture.markerFile, "'v1'", "'v2'")
    await waitForGeneration('v2', 2, 2, neem)
    await waitFor(() => (neem.updates() >= 1 ? true : undefined), 30_000, neem)

    const events = readRuntimeEvents(neem)
    const updatedStarts = events.filter(
      (event) => event.event === 'workflows:start' && event.marker === 'v2',
    )
    expect(updatedStarts).toHaveLength(2)
    expect(updatedStarts.map((event) => event.generation)).toStrictEqual([2, 2])
    for (const start of updatedStarts) {
      const previous = events.findIndex(
        (event) =>
          event.event === 'workflows:stop' &&
          event.threadId === start.threadId &&
          event.generation === 1,
      )
      expect(previous).toBeGreaterThanOrEqual(0)
      expect(previous).toBeLessThan(events.indexOf(start))
    }
    await replaceInFile(fixture.markerFile, "'v2'", "'v3'")
    await waitForGeneration('v3', 3, 2, neem)
  }, 60_000)

  it('omits DevEngine instrumentation from production worker artifacts', async () => {
    const fixture = await createFixture(mode)
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
    expect(exit.code, neem.diagnostics()).toBe(0)

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
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(resolve(tempRoot, 'hmr-'))
  const fixtureDir = resolve(dir, 'fixture')
  await cp(resolve(import.meta.dirname, 'fixtures/hmr'), fixtureDir, {
    recursive: true,
  })

  if (mode === 'Effect') {
    await cp(
      resolve(fixtureDir, 'effect.worker.ts'),
      resolve(fixtureDir, 'workflows.worker.ts'),
    )
  }

  return {
    configFile: resolve(fixtureDir, 'neem.config.ts'),
    markerFile: resolve(fixtureDir, 'marker.ts'),
    outDir: resolve(dir, '.neem'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function replaceInFile(
  file: string,
  search: string,
  replacement: string,
): Promise<void> {
  await updateFileAtomically(file, (content) => {
    expect(content).toContain(search)
    return content.replace(search, replacement)
  })
}

async function waitForGeneration(
  marker: string,
  generation: number,
  count: number,
  neem: SpawnedNeem,
): Promise<RuntimeEvent[]> {
  return waitFor(
    () => {
      const events = readRuntimeEvents(neem).filter(
        (event) =>
          event.event === 'workflows:start' &&
          event.marker === marker &&
          event.generation === generation,
      )
      return events.length >= count ? events : undefined
    },
    30_000,
    neem,
  )
}

function spawnNeem(args: readonly string[]) {
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, '../../neem/bin/neem.js'), ...args],
    {
      env: { ...process.env, NODE_ENV: 'test', NEEM_TEST_PROBE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  const probes: string[] = []
  child.on('message', (message: { event?: string }) => {
    if (message.event) probes.push(message.event)
  })
  let stdout = ''
  let stderr = ''
  let exitState:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const exit = new Promise<NonNullable<typeof exitState>>((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitState = { code, signal }
      resolveExit(exitState)
    })
  })

  return {
    diagnostics: () =>
      `stdout:\n${stdout}\nstderr:\n${stderr}\nprobes:\n${probes.join('\n')}`,
    updates: () =>
      probes.filter((event) => event === 'runtime:hmr-applied').length,
    exited: () => exitState,
    stdout: () => stdout,
    waitForExit: () => exit,
    async stop() {
      if (!exitState) child.kill('SIGTERM')
      if (!(await settlesWithin(exit, 2_000)) && !exitState) {
        child.kill('SIGKILL')
      }
      await exit
    },
  }
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

async function updateFileAtomically(
  file: string,
  update: (content: string) => string,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, update(await readFile(file, 'utf8')))
  await rename(temporary, file)
}

async function waitFor<T>(
  operation: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  neem: SpawnedNeem,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await operation()
    if (value !== undefined) return value
    if (neem.exited()) {
      throw new Error(
        `Neem exited before the expected event\n${neem.diagnostics()}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms\n${neem.diagnostics()}`)
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}
