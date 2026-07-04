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
import { createServer } from 'node:net'
import { basename, dirname, resolve } from 'node:path'

export type NeemProbeEvent = {
  source: 'neem:test-probe'
  event: string
  pid: number | undefined
  sequence: number
  timestamp: string
  [key: string]: unknown
}

type RawNeemProbeEvent = {
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
  stop: (
    options?: StopOptions,
  ) => Promise<{ code: number | null; signal: string | null }>
}

export type StopOptions = { killAfterMs?: number }

type ForceKillDetails = { killAfterMs: number; pid: number | undefined }

const defaultKillAfterMs = 2_000

const neemBin = resolve(import.meta.dirname, '../../../bin/neem.js')

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
  let forceKillDetails: ForceKillDetails | undefined

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
    if (isRawProbeEvent(message)) {
      events.push({
        ...message,
        pid: child.pid,
        sequence: events.length + 1,
        timestamp: new Date().toISOString(),
      })
    }
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
              formatProcessDiagnostics(
                events,
                stdout,
                stderr,
                forceKillDetails,
              ),
            ].join('\n'),
          )
        }

        await wait(25)
      }

      throw new Error(
        [
          `Timed out after ${timeoutMs}ms`,
          formatProcessDiagnostics(events, stdout, stderr, forceKillDetails),
        ].join('\n'),
      )
    },
    waitForExit: () => exit,
    async stop(options = {}) {
      const killAfterMs = options.killAfterMs ?? defaultKillAfterMs
      if (isChildRunning(child, exitState)) {
        child.kill('SIGTERM')
      }
      const stoppedGracefully = await Promise.race([
        exit.then(() => true),
        wait(killAfterMs).then(() => false),
      ])
      if (!stoppedGracefully && isChildRunning(child, exitState)) {
        forceKillDetails = { killAfterMs, pid: child.pid }
        child.kill('SIGKILL')
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
  const tempRoot = resolve(import.meta.dirname, '../.tmp')
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(resolve(tempRoot, 'case-'))
  const fixtureDir = resolve(dir, 'fixtures')
  await cp(resolve(import.meta.dirname, '../fixtures'), fixtureDir, {
    recursive: true,
  })

  return {
    dir,
    fixtureDir,
    configFile: resolve(
      fixtureDir,
      'cases',
      options.config ?? 'runtime',
      'neem.config.ts',
    ),
    appFile: resolve(fixtureDir, 'shared/workers/runtime-app.ts'),
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
  return getCompleteJsonLines(content).map(
    (line) => JSON.parse(line) as RuntimeEvent,
  )
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

export async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate local TCP port'))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

export async function getDistinctFreePorts(count: number): Promise<number[]> {
  const ports = new Set<number>()
  while (ports.size < count) ports.add(await getFreePort())
  return [...ports]
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRawProbeEvent(message: unknown): message is RawNeemProbeEvent {
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

function formatProcessDiagnostics(
  events: readonly NeemProbeEvent[],
  stdout: string,
  stderr: string,
  forceKillDetails: ForceKillDetails | undefined,
): string {
  return [
    forceKillDetails
      ? `Process was force-killed after ${forceKillDetails.killAfterMs}ms with SIGKILL (pid ${forceKillDetails.pid ?? 'unknown'})`
      : undefined,
    `events:\n${JSON.stringify(events, null, 2)}`,
    formatProcessOutput(stdout, stderr),
  ]
    .filter(Boolean)
    .join('\n')
}

function isChildRunning(
  child: ChildProcess,
  exitState: { code: number | null; signal: string | null } | undefined,
): boolean {
  return !exitState && child.exitCode === null && child.signalCode === null
}

function getCompleteJsonLines(content: string): string[] {
  if (!content) return []
  const lines = content.split('\n')
  if (!content.endsWith('\n')) lines.pop()
  return lines.filter(Boolean)
}

export type RuntimeEvent = {
  event: string
  name?: string
  mode?: string
  data?: Record<string, unknown>
  definition?: { fixture?: string }
  [key: string]: unknown
}
