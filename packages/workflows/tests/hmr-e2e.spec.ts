import { spawn } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
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

describe('Neem workflows HMR', () => {
  it('rotates worker generations without rebuilding planner topology', async () => {
    const fixture = await createFixture()
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
    await new Promise((resolve) => setTimeout(resolve, 250))

    const updatedStarts = readRuntimeEvents(neem).filter(
      (event) => event.event === 'workflows:start' && event.marker === 'v2',
    )
    expect(updatedStarts).toHaveLength(2)
    expect(updatedStarts.map((event) => event.generation)).toStrictEqual([2, 2])
  }, 60_000)
})

async function createFixture() {
  const tempRoot = resolve(import.meta.dirname, '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(resolve(tempRoot, 'hmr-'))
  const fixtureDir = resolve(dir, 'fixture')
  await cp(resolve(import.meta.dirname, 'fixtures/hmr'), fixtureDir, {
    recursive: true,
  })

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
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let exitState:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const exit = new Promise<typeof exitState>((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitState = { code, signal }
      resolveExit(exitState)
    })
  })

  return {
    diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
    exited: () => exitState,
    stdout: () => stdout,
    async stop() {
      if (!exitState) child.kill('SIGTERM')
      if (!(await settlesWithin(exit, 2_000)) && !exitState) {
        child.kill('SIGKILL')
      }
      await exit
    },
  }
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
  const temporary = `${file}.${process.pid}.tmp`
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
  throw new Error(`Timed out after ${timeoutMs}ms`)
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
