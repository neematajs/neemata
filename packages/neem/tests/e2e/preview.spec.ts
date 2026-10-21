import { readFileSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import type { NeemProbeEvent } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  runNeem,
  spawnNeem,
  spawnNode,
  updateFileAtomically,
  waitFor,
  writeProductionImportGuard,
} from './support/e2e.ts'

const bin = resolve(import.meta.dirname, '../../bin/neem.js')

it('builds in an exited child process, then serves its own output in production mode', async () => {
  const fixture = await createNeemFixture()
  const configDir = dirname(fixture.configFile)
  // A custom pipeline records the context Neem hands its plugins.
  await updateFileAtomically(resolve(configDir, 'api.runtime.ts'), (source) =>
    source.replace(
      "worker: { entry: '../../shared/workers/runtime-app.ts' },",
      `worker: {
        entry: '../../shared/workers/runtime-app.ts',
        build: { rolldown: { plugins: [context()] } },
      },`,
    ),
  )
  await updateFileAtomically(
    resolve(configDir, 'api.runtime.ts'),
    (source) => `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
${source}
function context() {
  let command = 'none'
  return {
    name: 'record-context',
    configureNeemBuild: (ctx) => { command = ctx.command + ':' + ctx.mode + ':' + ctx.sourcemap },
    writeBundle: (output) => writeFileSync(join(output.dir, 'context.txt'), command),
  }
}
`,
  )
  const helperPidFile = resolve(fixture.dir, 'helper.pid')
  await updateFileAtomically(
    fixture.configFile,
    (source) => startBuildHelper(helperPidFile) + source,
  )
  // A builder's helper that reads its inherited stdin to the end finishes
  // instead of holding the build.
  const readStdin = `import { execFileSync as runStdinReader } from 'node:child_process'
runStdinReader(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['inherit', 'ignore', 'inherit'], timeout: 10_000 })
`
  await updateFileAtomically(fixture.configFile, (source) => readStdin + source)
  const guard = resolve(fixture.fixtureDir, 'production-import-guard.mjs')
  await writeProductionImportGuard(guard)

  const neem = spawnNode(
    [
      '--import',
      guard,
      // The build process must not reuse an inspector option's value as its
      // script (Bun has no such option).
      ...(process.versions.bun ? [] : ['--inspect-port', '0']),
      bin,
      'preview',
      '--config',
      fixture.configFile,
    ],
    { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
  )
  await neem.waitForEvent((event) => event.event === 'runtime:ready', 60_000)
  // A builder's helper that outlives a successful build is stopped before
  // serving, even though it ignores SIGTERM.
  expect(isAlive(Number(await readFile(helperPidFile, 'utf8')))).toBe(false)

  const built = neem
    .events()
    .find((event) => event.event === 'cli:preview:build:closed')
  expect(built?.built).toBe(true)
  expect(isAlive(built?.buildPid)).toBe(false)
  const outDir = resolve(configDir, '.neem/preview/neem.config')
  expect(
    neem.events().find((event) => event.event === 'cli:preview:start')?.outDir,
  ).toBe(outDir)
  await expect(access(resolve(configDir, 'dist'))).rejects.toThrow()

  const manifest = JSON.parse(
    await readFile(resolve(outDir, 'neem.manifest.json'), 'utf8'),
  )
  const workerFile = resolve(outDir, manifest.runtimes.api.worker.file)
  await access(`${workerFile}.map`)
  await expect(
    readFile(resolve(dirname(workerFile), 'context.txt'), 'utf8'),
  ).resolves.toBe('preview:production:true')
  const created = (await readRuntimeEvents(fixture.eventsFile)).filter(
    (event) => event.event === 'create',
  )
  expect(created.length).toBeGreaterThan(0)
  expect(created.every((event) => event.mode === 'production')).toBe(true)

  expect(await neem.stop()).toEqual({ code: 0, signal: null })
}, 90_000)

it('does not serve earlier output when the preview build fails', async () => {
  const fixture = await createNeemFixture()
  const configDir = dirname(fixture.configFile)
  const outDir = resolve(configDir, '.neem/preview/neem.config')
  // Valid output a stale-serving preview could start.
  await runNeem(['build', '--config', fixture.configFile, '--out-dir', outDir])
  await writeFile(fixture.appFile, 'export default {\n')

  const neem = spawnNeem(['preview', '--config', fixture.configFile])
  const exit = await neem.waitForExit()

  expect(exit.code).not.toBe(0)
  expect(neem.stderr()).toContain('Neem preview build failed')
  expect(hasEvent(neem.events(), 'runtime:ready')).toBe(false)
  expect(hasEvent(neem.events(), 'cli:start:start')).toBe(false)
}, 60_000)

it('stops a helper left by a failed build and reports the whole build error', async () => {
  const fixture = await createNeemFixture()
  const helperPidFile = resolve(fixture.dir, 'helper.pid')
  // Several pipe buffers of diagnostics: the build process must not exit
  // before its output is written. A framework logger that takes over the
  // console writes the build error to the stream, as Nuxt's does.
  const marker = 'end-of-build-diagnostic'
  await updateFileAtomically(
    fixture.configFile,
    (source) =>
      `${startBuildHelper(helperPidFile)}console.error = (error) => process.stderr.write(String(error?.stack ?? error))
throw new Error('x'.repeat(512 * 1024) + ${JSON.stringify(marker)})\n${source}`,
  )

  const neem = spawnNeem(['preview', '--config', fixture.configFile])
  const exit = await neem.waitForExit()

  expect(exit.code).not.toBe(0)
  expect(neem.stderr()).toContain(marker)
  expect(neem.stderr()).toContain('Neem preview build failed')
  expect(isAlive(await waitForPid(helperPidFile))).toBe(false)
  expect(hasEvent(neem.events(), 'runtime:ready')).toBe(false)
}, 60_000)

it('stops the build process tree and exits without serving when interrupted during the build', async () => {
  const fixture = await createNeemFixture()
  const helperPidFile = resolve(fixture.dir, 'helper.pid')
  await updateFileAtomically(
    fixture.configFile,
    (source) =>
      `${startBuildHelper(helperPidFile)}await new Promise((resolve) => setTimeout(resolve, 60_000))\n${source}`,
  )

  const neem = spawnNeem(['preview', '--config', fixture.configFile])
  const started = await neem.waitForEvent(
    (event) => event.event === 'cli:preview:build:start',
    30_000,
  )
  const helperPid = await waitForPid(helperPidFile)
  const stoppedAt = Date.now()
  expect(await neem.stop({ killAfterMs: 10_000 })).toEqual({
    code: 0,
    signal: null,
  })
  expect(Date.now() - stoppedAt).toBeLessThan(10_000)
  expect(isAlive(started.buildPid)).toBe(false)
  // The build process exits on SIGTERM first; escalation still reaches the
  // helper that ignores it.
  expect(isAlive(helperPid)).toBe(false)
  expect(
    neem.events().find((event) => event.event === 'cli:preview:build:closed')
      ?.built,
  ).toBe(false)
  expect(hasEvent(neem.events(), 'runtime:ready')).toBe(false)
}, 60_000)

// Neither signal lets the preview process clean up, and the build's own
// session keeps a terminal hangup from reaching it. On Windows the build stops
// without its helpers, which have no process group to stop them by.
describe.skipIf(process.platform === 'win32')(
  'when the preview process dies during the build',
  () => {
    it.each(['SIGKILL', 'SIGHUP'] as const)(
      'stops the build process tree (%s)',
      async (signal) => {
        const fixture = await createNeemFixture()
        const helperPidFile = resolve(fixture.dir, 'helper.pid')
        await updateFileAtomically(
          fixture.configFile,
          (source) =>
            `${startBuildHelper(helperPidFile)}await new Promise((resolve) => setTimeout(resolve, 60_000))\n${source}`,
        )

        const neem = spawnNeem(['preview', '--config', fixture.configFile])
        const started = await neem.waitForEvent(
          (event) => event.event === 'cli:preview:build:start',
          30_000,
        )
        const buildPid = started.buildPid as number
        // Nothing else stops an orphaned build when this test fails; the
        // helper is a member of the build's group.
        onTestFinished(() => {
          try {
            process.kill(-buildPid, 'SIGKILL')
          } catch {}
        })
        const helperPid = await waitForPid(helperPidFile)

        neem.child.kill(signal)
        expect(await neem.waitForExit()).toEqual({ code: null, signal })
        await waitFor(() => !isAlive(buildPid) && !isAlive(helperPid), 10_000)
      },
      60_000,
    )
  },
)

// Preview maps stacks by default, also under a plain `node` launch; the
// user's own opt-out wins (Bun has no such flag).
it.each(
  process.versions.bun
    ? [{ flags: [], mapped: true }]
    : [
        { flags: [], mapped: true },
        { flags: ['--no-enable-source-maps'], mapped: false },
      ],
)(
  'serves preview stack traces through source maps unless opted out (node flags: $flags)',
  async ({ flags, mapped }: { flags: string[]; mapped: boolean }) => {
    const fixture = await createNeemFixture({ config: 'start-failure-cleanup' })
    const logFile = resolve(fixture.dir, 'errors.jsonl')
    const neem = spawnNode(
      [
        ...flags,
        bin,
        'preview',
        '--config',
        fixture.configFile,
        '--out-dir',
        fixture.outDir,
      ],
      { env: { NEEM_LOG_EVENTS_FILE: logFile } },
    )
    expect((await neem.waitForExit()).code).not.toBe(0)
    const logs = await readFile(logFile, 'utf8')
    expect(logs).toContain('partial startup failure')
    // Bun 1.4.3 reports generated locations for these external maps.
    if (!process.versions.bun) expectMappedStacks(logs, mapped)
  },
  60_000,
)

function expectMappedStacks(logs: string, mapped: boolean): void {
  const source = /partial\.worker\.ts:\d+:\d+/
  const generated = /partial\.worker-[^\s"]+\.js:\d+:\d+/
  expect(logs).toMatch(mapped ? source : generated)
  expect(logs).not.toMatch(mapped ? generated : source)
}

/**
 * Config prelude standing in for a helper process a framework builder
 * starts: it ignores SIGTERM and reports its pid once that holds.
 */
function startBuildHelper(pidFile: string): string {
  const helper = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  return `import { spawn as spawnHelper } from 'node:child_process'
import { existsSync as helperStarted } from 'node:fs'
spawnHelper(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' }).unref()
while (!helperStarted(${JSON.stringify(pidFile)})) await new Promise((resolve) => setTimeout(resolve, 20))
`
}

async function waitForPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await readFile(file, 'utf8').catch(() => '')
    if (value) return Number(value)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`No pid in ${file}`)
}

function hasEvent(events: readonly NeemProbeEvent[], name: string): boolean {
  return events.some((event) => event.event === name)
}

/**
 * Whether a process can still run. An orphan stays a zombie under a PID 1
 * that never reaps, as in some containers, and `kill` still finds it.
 */
function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number') throw new Error('Missing build process pid')
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))
  } catch (error) {
    // Reaped since the check above.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
