import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  expectFile,
  readRuntimeEvents,
  spawnNode,
  waitFor,
} from './support/e2e.ts'

type WorkspacePackage = 'common' | 'core' | 'neem' | 'type'

type CommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

const tempDirs: string[] = []
const spawned: SpawnedNeem[] = []

const e2eDir = import.meta.dirname
const neemPackageDir = resolve(e2eDir, '../..')
const workspaceRoot = resolve(neemPackageDir, '../..')
const consumerFixtureDir = resolve(e2eDir, 'fixtures/consumer')

const stagedPackages: readonly WorkspacePackage[] = [
  'common',
  'type',
  'core',
  'neem',
]

const internalPackageDirs = new Map<string, WorkspacePackage>([
  ['@nmtjs/common', 'common'],
  ['@nmtjs/core', 'core'],
  ['@nmtjs/type', 'type'],
])

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((node) => node.stop()))
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('Neem package consumer smoke', () => {
  it('typechecks NodeNext imports, builds, and starts through the package boundary', async () => {
    const fixture = await createConsumerFixture()

    await installConsumer(fixture.consumerDir)

    const installedPackageJson = JSON.parse(
      await readFile(
        resolve(fixture.consumerDir, 'node_modules/@nmtjs/neem/package.json'),
        'utf8',
      ),
    ) as { exports: { '.': { types: string } } }

    expect(installedPackageJson.exports['.'].types).toBe(
      './dist/public/index.d.ts',
    )
    await expectFile(
      resolve(
        fixture.consumerDir,
        'node_modules/@nmtjs/neem/dist/shared/types.d.ts',
      ),
    )

    await runPnpm(['run', 'typecheck'], fixture.consumerDir, 90_000)
    await runPnpm(['run', 'build'], fixture.consumerDir, 90_000)
    await expectFile(resolve(fixture.consumerDir, 'dist/start.js'))

    const node = spawnTrackedNode(
      [resolve(fixture.consumerDir, 'dist/start.js')],
      {
        cwd: fixture.consumerDir,
        env: { NEEM_PACKAGING_EVENTS_FILE: fixture.eventsFile },
      },
    )

    const events = await waitFor(
      async () => {
        const current = await readRuntimeEvents(fixture.eventsFile)
        return current.some(
          (event) =>
            event.event === 'start' && event.message === 'packaging-smoke',
        )
          ? current
          : false
      },
      30_000,
      () => formatSpawnedOutput(node),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'start', message: 'packaging-smoke' }),
      ]),
    )

    await node.stop()
  }, 120_000)
})

async function createConsumerFixture(): Promise<{
  consumerDir: string
  eventsFile: string
}> {
  const rootDir = await mkdtemp(resolve(tmpdir(), 'neem-packaging-'))
  tempDirs.push(rootDir)

  const consumerDir = resolve(rootDir, 'consumer')
  const packagesDir = resolve(rootDir, 'packages')
  await cp(consumerFixtureDir, consumerDir, { recursive: true })
  await stagePublishedPackages(packagesDir)

  return { consumerDir, eventsFile: resolve(rootDir, 'events.jsonl') }
}

async function stagePublishedPackages(packagesDir: string): Promise<void> {
  await mkdir(packagesDir, { recursive: true })

  await Promise.all(
    stagedPackages.map(async (packageName) => {
      const sourceDir = resolve(workspaceRoot, 'packages', packageName)
      const packageDir = resolve(packagesDir, packageName)

      await mkdir(packageDir, { recursive: true })
      await cp(resolve(sourceDir, 'dist'), resolve(packageDir, 'dist'), {
        recursive: true,
      })
      if (packageName === 'neem') {
        await cp(resolve(sourceDir, 'bin'), resolve(packageDir, 'bin'), {
          recursive: true,
        })
      }

      const manifest = JSON.parse(
        await readFile(resolve(sourceDir, 'package.json'), 'utf8'),
      ) as PackageJson

      await writeFile(
        resolve(packageDir, 'package.json'),
        `${JSON.stringify(toPublishedManifest(manifest), null, 2)}\n`,
      )
    }),
  )
}

function toPublishedManifest(manifest: PackageJson): PackageJson {
  // `pnpm --dir packages/neem pack` currently fails with
  // `[ERR_PNPM_PACKAGE_VERSION_NOT_FOUND] Package version is not defined in the package.json.`
  // This temp manifest mirrors the published boundary by applying publishConfig
  // exports to the already built package and rewriting monorepo-only specs.
  const published: PackageJson = {
    ...manifest,
    version: '0.0.0',
    exports: manifest.publishConfig?.exports ?? manifest.exports,
    dependencies: rewriteDependencies(manifest.dependencies, 'dependencies'),
    peerDependencies: rewriteDependencies(
      manifest.peerDependencies,
      'peerDependencies',
    ),
  }

  delete published.devDependencies
  delete published.files
  delete published.publishConfig
  delete published.scripts

  return published
}

function rewriteDependencies(
  dependencies: Record<string, string> | undefined,
  kind: 'dependencies' | 'peerDependencies',
): Record<string, string> | undefined {
  if (!dependencies) return undefined

  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (spec.startsWith('workspace:')) {
        const packageDir = internalPackageDirs.get(name)
        const rewritten =
          kind === 'dependencies' && packageDir
            ? `file:../${packageDir}`
            : '0.0.0'
        return [name, rewritten]
      }

      if (spec === 'catalog:') return [name, '^4.0.0']

      return [name, spec]
    }),
  )
}

async function installConsumer(consumerDir: string): Promise<void> {
  await runPnpm(
    [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--lockfile=false',
      '--config.auto-install-peers=false',
    ],
    consumerDir,
    90_000,
  )
}

async function runPnpm(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return await runCommand('pnpm', args, { cwd, timeoutMs })
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  const result = await spawnCommand(command, args, options)
  if (result.code !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with code ${result.code} and signal ${result.signal}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join('\n'),
    )
  }
  return result
}

function spawnCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new Error(
          [
            `${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`,
            `stdout:\n${stdout}`,
            `stderr:\n${stderr}`,
          ].join('\n'),
        ),
      )
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveCommand({ code, signal, stdout, stderr })
    })
  })
}

function spawnTrackedNode(
  args: readonly string[],
  options: Parameters<typeof spawnNode>[1],
): SpawnedNeem {
  const node = spawnNode(args, options)
  spawned.push(node)
  return node
}

function formatSpawnedOutput(neem: SpawnedNeem): string {
  return [`stdout:\n${neem.stdout()}`, `stderr:\n${neem.stderr()}`].join('\n')
}

type PackageJson = {
  [key: string]: unknown
  exports?: unknown
  publishConfig?: { exports?: unknown }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  files?: readonly string[]
  scripts?: Record<string, string>
}
