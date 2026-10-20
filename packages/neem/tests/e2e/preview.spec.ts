import { readFileSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { expect, it } from 'vitest'

import type { NeemProbeEvent } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  runNeem,
  spawnNeem,
  spawnNode,
  updateFileAtomically,
  writeProductionImportGuard,
} from './support/e2e.ts'

const bin = resolve(import.meta.dirname, '../../bin/neem.js')

it('builds in an exited child process, then serves its own output in production mode', async () => {
  const fixture = await createNeemFixture()
  const configDir = dirname(fixture.configFile)
  // Preview forces maps that a deployment config turned off.
  await updateFileAtomically(fixture.configFile, (source) =>
    source.replace(
      'defineConfig({',
      'defineConfig({ build: { sourcemap: false },',
    ),
  )
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
    configureNeemBuild: (ctx) => { command = ctx.command + ':' + ctx.mode },
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
  ).resolves.toBe('preview:production')
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

// A plain `node` launch has no shebang flags, and preview enables maps even
// against an explicit opt-out (Bun has no such flag).
it.each(
  process.versions.bun
    ? [{ flags: [] }]
    : [{ flags: [] }, { flags: ['--no-enable-source-maps'] }],
)(
  'serves preview stack traces through source maps (node flags: $flags)',
  async ({ flags }: { flags: string[] }) => {
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
    if (!process.versions.bun) {
      expect(logs).toMatch(/partial\.worker\.ts:\d+:\d+/)
      expect(logs).not.toMatch(/partial\.worker-[^\s"]+\.js:\d+:\d+/)
    }
  },
  60_000,
)

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
