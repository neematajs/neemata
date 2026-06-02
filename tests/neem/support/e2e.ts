import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export type NeemProbeEvent = {
  source: 'neem:test-probe'
  event: string
  [key: string]: unknown
}

export type SpawnedNeem = {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  events: () => readonly NeemProbeEvent[]
  waitForEvent: (
    predicate: (event: NeemProbeEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<NeemProbeEvent>
  waitForExit: () => Promise<{ code: number | null; signal: string | null }>
  stop: () => Promise<{ code: number | null; signal: string | null }>
}

const neemBin = resolve(
  import.meta.dirname,
  '../../../packages/neem/bin/neem.js',
)

export function spawnNeem(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnedNeem {
  return spawnNode([neemBin, ...args], options)
}

export function spawnNode(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnedNeem {
  const events: NeemProbeEvent[] = []
  let stdout = ''
  let stderr = ''
  let exitState: { code: number | null; signal: string | null } | undefined

  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEEM_TEST_PROBE: '1',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.on('message', (message) => {
    if (isProbeEvent(message)) events.push(message)
  })

  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        exitState = { code, signal }
        resolveExit(exitState)
      })
    },
  )

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    events: () => events,
    async waitForEvent(predicate, timeoutMs = 10_000) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const event = events.find(predicate)
        if (event) return event

        if (exitState) {
          throw new Error(
            [
              `Process exited before expected event with code ${exitState.code} and signal ${exitState.signal}`,
              `events:\n${JSON.stringify(events, null, 2)}`,
              formatProcessOutput(stdout, stderr),
            ].join('\n'),
          )
        }

        await wait(25)
      }

      throw new Error(
        [
          `Timed out after ${timeoutMs}ms`,
          `events:\n${JSON.stringify(events, null, 2)}`,
          formatProcessOutput(stdout, stderr),
        ].join('\n'),
      )
    },
    waitForExit: () => exit,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
      return await exit
    },
  }
}

export async function runNeem(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnedNeem> {
  const neem = spawnNeem(args, options)
  const exit = await neem.waitForExit()
  if (exit.code !== 0) {
    throw new Error(
      `neem ${args.join(' ')} failed with code ${exit.code}\n${formatProcessOutput(
        neem.stdout(),
        neem.stderr(),
      )}`,
    )
  }
  return neem
}

export async function createNeemFixture(
  options: { config?: string } = {},
): Promise<{
  dir: string
  fixtureDir: string
  configFile: string
  appFile: string
  outDir: string
  eventsFile: string
  cleanup: () => Promise<void>
}> {
  const tempRoot = resolve(import.meta.dirname, '../.tmp-e2e')
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(resolve(tempRoot, 'case-'))
  const fixtureDir = resolve(dir, 'fixtures')
  await cp(resolve(import.meta.dirname, '../fixtures'), fixtureDir, {
    recursive: true,
  })

  return {
    dir,
    fixtureDir,
    configFile: resolve(fixtureDir, options.config ?? 'runtime.config.ts'),
    appFile: resolve(fixtureDir, 'runtime-app.ts'),
    outDir: resolve(dir, 'dist'),
    eventsFile: resolve(dir, 'events.jsonl'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export async function readRuntimeEvents(file: string): Promise<RuntimeEvent[]> {
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

export async function expectFile(path: string): Promise<void> {
  await access(path)
}

export async function updateFileAtomically(
  path: string,
  update: (content: string) => string,
): Promise<void> {
  const content = await readFile(path, 'utf8')
  await writeFileAtomically(path, update(content))
}

export async function writeFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const tempFile = resolve(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  )

  try {
    await writeFile(tempFile, content)
    await rename(tempFile, path)
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 5_000,
  getDetails: () => string = () => '',
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
    await wait(25)
  }
  const details = getDetails()
  if (lastError) {
    throw new Error(`Timed out after ${timeoutMs}ms\n${details}`, {
      cause: lastError,
    })
  }
  throw new Error(`Timed out after ${timeoutMs}ms\n${details}`)
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProbeEvent(message: unknown): message is NeemProbeEvent {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as NeemProbeEvent).source === 'neem:test-probe' &&
    typeof (message as NeemProbeEvent).event === 'string'
  )
}

function formatProcessOutput(stdout: string, stderr: string): string {
  return [`stdout:\n${stdout}`, `stderr:\n${stderr}`].join('\n')
}

export type RuntimeEvent = {
  event: string
  name?: string
  mode?: string
  data?: Record<string, unknown>
  definition?: { fixture?: string }
  [key: string]: unknown
}
