import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BuildOptions, OutputBundle, RolldownOutput } from 'rolldown'
import { createFuture } from '@nmtjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuildTarget } from '../../src/internal/build/graph.ts'
import {
  compileGraph,
  compileTarget,
  watchGraph,
  watchTarget,
} from '../../src/internal/build/compiler.ts'
import { createBuildGraph } from '../../src/internal/build/graph.ts'
import { raceWithTimeout } from '../../src/internal/utils.ts'
import { defineRuntime } from '../../src/public/config.ts'
import { createTempDir } from '../support/temp.ts'

const rolldownMock = vi.hoisted(() => ({ build: vi.fn(), watch: vi.fn() }))
// The DevEngine stays real; the spy records the options Neem hands it.
const devSpy = vi.hoisted(() => ({ dev: vi.fn() }))

vi.mock('rolldown', () => rolldownMock)
vi.mock('rolldown/experimental', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rolldown/experimental')>()
  devSpy.dev.mockImplementation(actual.dev)
  return { ...actual, dev: devSpy.dev }
})

beforeEach(() => {
  rolldownMock.build.mockReset()
  rolldownMock.watch.mockReset()
  devSpy.dev.mockClear()
})

// On macOS, Rolldown (1.2.11) restarts its FSEvents stream after every rebuild,
// even when no watched path changed, and a write landing in that gap is never
// reported. Write until the engine reports so these cases test Neem, not that
// race.
async function editUntilReported(
  file: string,
  content: string,
  reported: () => Promise<unknown>,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await writeFile(file, `${content}${'\n'.repeat(attempt)}`)
    const result = await raceWithTimeout(reported(), 1_500)
    if (!result.timedOut) return result.value
    if (attempt >= 8) throw new Error(`DevEngine never reported ${file}`)
  }
}

// These drive a real DevEngine through file-system events, whose latency
// under a loaded machine exceeds the default test timeout.
const DEV_ENGINE_TEST_TIMEOUT_MS = 20_000

describe('Neem compiler', () => {
  it('compiles infra targets with one multi-entry rolldown build', async () => {
    const root = await createTempDir('neem-compiler-')
    const graph = createCompilerGraph(root)
    rolldownMock.build.mockImplementation(async (options: BuildOptions) => {
      const input = options.input
      if (isRecord(input)) {
        return { output: multiOutput(input) } as unknown as RolldownOutput
      }
      const target = graph.targets.find(
        (target) => target.artifact.entry === input,
      )
      if (!target) throw new Error(`Unknown test input: ${String(input)}`)
      return rolldownOutput('index.js', target)
    })

    const compiled = await compileGraph(graph)

    expect(rolldownMock.build).toHaveBeenCalledTimes(4)
    const infraOptions = findInfraOptions(rolldownMock.build.mock.calls)
    expect(infraOptions.input).toEqual({
      start: entryPath(graph.startEntry),
      'worker-entry': entryPath(graph.workerEntry),
      'runner-entry': entryPath(graph.hostRunnerEntry),
    })
    expect(infraOptions.output).toMatchObject({
      dir: resolve(root, 'dist/runtime'),
      entryFileNames: '[name].js',
    })
    expect(infraOptions.treeshake).toBeUndefined()
    // The default deps group must not swallow the grouped entry modules: when
    // Neem is installed as a dependency they resolve under node_modules, and
    // merging worker/runner entry code into the shared deps chunk breaks the
    // main-thread start path (see packaging e2e).
    const depsGroup = getCodeSplittingGroups(infraOptions).at(-1) as {
      name: string
      test: (id: string) => boolean
    }
    expect(depsGroup.name).toBe('deps')
    expect(depsGroup.test).toBeTypeOf('function')
    expect(depsGroup.test('/repo/node_modules/zod/index.js')).toBe(true)
    expect(depsGroup.test(entryPath(graph.workerEntry))).toBe(false)
    expect(depsGroup.test(entryPath(graph.hostRunnerEntry))).toBe(false)
    expect(depsGroup.test(entryPath(graph.startEntry))).toBe(false)
    expect(compiled.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: graph.startEntry,
          artifact: expect.objectContaining({
            file: resolve(root, 'dist/runtime/start.js'),
          }),
        }),
        expect.objectContaining({
          target: graph.workerEntry,
          artifact: expect.objectContaining({
            file: resolve(root, 'dist/runtime/worker-entry.js'),
          }),
        }),
        expect.objectContaining({
          target: graph.hostRunnerEntry,
          artifact: expect.objectContaining({
            file: resolve(root, 'dist/runtime/runner-entry.js'),
          }),
        }),
      ]),
    )
  })

  it('does not retain rolldown output objects after compiling a target', async () => {
    const target = await createTarget()
    const output = rolldownOutput('compiled-entry.js', target)
    rolldownMock.build.mockResolvedValue(output)

    const compiled = await compileTarget(target)
    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions

    expect(compiled.artifact.file).toBe(
      resolve(target.outDir, 'compiled-entry.js'),
    )
    expect(compiled.bundle).toBeUndefined()
    expect(options.treeshake).toBeUndefined()
  })

  it('appends default deps chunk group after user chunk groups', async () => {
    const target = await createTarget()
    const localGroup = { name: 'local', test: /perf-large-ts-modules/ }
    target.artifact.chunks = { groups: [localGroup] }
    rolldownMock.build.mockResolvedValue(rolldownOutput('index.js', target))

    await compileTarget(target)

    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
    expect(options.output).toMatchObject({
      codeSplitting: {
        groups: [localGroup, { name: 'deps', test: /node_modules/ }],
      },
    })
  })

  it('lets a user deps chunk group replace the default deps group', async () => {
    const target = await createTarget()
    const depsGroup = { name: 'deps', test: /node_modules\/zod/ }
    target.artifact.chunks = { groups: [depsGroup] }
    rolldownMock.build.mockResolvedValue(rolldownOutput('index.js', target))

    await compileTarget(target)

    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
    expect(options.output).toMatchObject({
      codeSplitting: { groups: [depsGroup] },
    })
  })

  it('disables code splitting when chunks is false', async () => {
    const target = await createTarget()
    target.artifact.chunks = false
    rolldownMock.build.mockResolvedValue(rolldownOutput('index.js', target))

    await compileTarget(target)

    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
    expect((options.output as { codeSplitting?: unknown }).codeSplitting).toBe(
      undefined,
    )
  })

  it.each(['plugin-entry', 'logger'] as const)(
    'emits a watched %s target as one file and splits it in production',
    async (kind) => {
      const target = { ...(await createTarget()), kind }
      rolldownMock.watch.mockReturnValue(createWatcher())
      rolldownMock.build.mockResolvedValue(rolldownOutput('index.js', target))

      await watchTarget(target)
      await compileTarget(target)

      const watched = rolldownMock.watch.mock.calls[0]?.[0] as BuildOptions
      const built = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
      // A cache-busted import of the entry must reach every module it loads.
      expect(watched.output).toMatchObject({ codeSplitting: false })
      expect(built.output).toMatchObject({
        codeSplitting: { groups: [{ name: 'deps', test: /node_modules/ }] },
      })
    },
  )

  it('keeps splitting watched targets that each start in a fresh thread', async () => {
    const target = await createTarget()
    rolldownMock.watch.mockReturnValue(createWatcher())

    await watchTarget(target)

    const watched = rolldownMock.watch.mock.calls[0]?.[0] as BuildOptions
    expect(watched.output).toMatchObject({
      codeSplitting: { groups: [{ name: 'deps', test: /node_modules/ }] },
    })
  })

  it('uses the watcher initial build as ready output', async () => {
    const target = await createTarget()
    rolldownMock.build.mockResolvedValue(
      rolldownOutput('wasted-build.js', target),
    )
    const watcher = createWatcher()
    rolldownMock.watch.mockReturnValue(watcher)

    const targetWatcher = await watchTarget(target)
    const watchOptions = rolldownMock.watch.mock.calls[0]?.[0] as BuildOptions
    collectEntryMetadata(watchOptions, outputBundle('watch-entry.js', target))

    const initialResult = { close: vi.fn(async () => {}) }
    watcher.emit('event', { code: 'BUNDLE_END', result: initialResult })
    watcher.emit('event', { code: 'END' })

    const compiled = await targetWatcher.ready

    expect(rolldownMock.build).not.toHaveBeenCalled()
    expect(compiled.artifact.file).toBe(
      resolve(target.outDir, 'watch-entry.js'),
    )
    expect(compiled.bundle).toBeUndefined()
    expect(initialResult.close).toHaveBeenCalledTimes(1)
  })

  it('does not set a default watcher build delay', async () => {
    const target = await createTarget()
    rolldownMock.watch.mockReturnValue(createWatcher())

    await watchTarget(target)

    const options = rolldownMock.watch.mock.calls[0]?.[0] as BuildOptions
    expect(options.watch).toMatchObject({
      clearScreen: false,
      watcher: { debounceDelay: 50, useDebounce: true },
    })
    expect(options.watch).not.toHaveProperty('buildDelay')
  })

  it('uses root watch config for build delay and debounce', async () => {
    const root = await createTempDir('neem-compiler-')
    const graph = createCompilerGraph(
      root,
      {
        watch: { buildDelay: 125, debounceDelay: 25 },
      },
      false,
    )
    rolldownMock.watch.mockImplementation(() => createWatcher())

    await watchGraph(graph)

    for (const [options] of rolldownMock.watch.mock.calls) {
      expect((options as BuildOptions).watch).toMatchObject({
        buildDelay: 125,
        clearScreen: false,
        watcher: { debounceDelay: 25, useDebounce: true },
      })
    }
  })

  it('passes polling options to the bundle watcher only when enabled', async () => {
    const root = await createTempDir('neem-compiler-')
    rolldownMock.watch.mockImplementation(() => createWatcher())

    await watchGraph(
      createCompilerGraph(root, { watch: { pollInterval: 25 } }, false),
    )
    for (const [options] of rolldownMock.watch.mock.calls) {
      const watcher = fileWatcherOptions(options as BuildOptions)
      expect(watcher).not.toHaveProperty('usePolling')
      expect(watcher).not.toHaveProperty('pollInterval')
    }

    rolldownMock.watch.mockClear()
    await watchGraph(
      createCompilerGraph(
        root,
        { watch: { usePolling: true, pollInterval: 25 } },
        false,
      ),
    )
    for (const [options] of rolldownMock.watch.mock.calls) {
      expect(fileWatcherOptions(options as BuildOptions)).toMatchObject({
        usePolling: true,
        pollInterval: 25,
      })
    }
  })

  it(
    'polls the worker sources when the watch config asks for it',
    async () => {
      const root = await createTempDir('neem-compiler-')
      const valueFile = resolve(root, 'api/value.ts')
      await mkdir(resolve(root, 'api'), { recursive: true })
      await writeFile(
        resolve(root, 'api/worker.ts'),
        "export { value as default } from './value.ts'\n",
      )
      await writeFile(valueFile, "export const value = 'v1'\n")
      const graph = createCompilerGraph(root, {
        watch: { usePolling: true, pollInterval: 25 },
      })
      const workerGraph = {
        ...graph,
        runtimes: [],
        buildGroups: graph.buildGroups.filter(
          (group) =>
            group.kind === 'target' && group.target.kind === 'runtime-worker',
        ),
      }
      const settled = createFuture<unknown>()
      const watcher = await watchGraph(workerGraph, {
        onUpdates: (_runtimeName, updates) => settled.resolve(updates),
        onUpdateError: (_runtimeName, error) => settled.resolve(error),
      })
      try {
        expect(devSpy.dev).toHaveBeenCalledTimes(1)
        expect(devSpy.dev.mock.calls[0]?.[2]?.watch).toMatchObject({
          usePolling: true,
          pollInterval: 25,
        })
        await watcher.addPatchClient('api', 'client')
        // A polling watcher has no event-stream gap, so one write suffices.
        await writeFile(valueFile, "export const value = 'v2'\n")
        const result = await raceWithTimeout(settled.promise, 5_000)
        if (result.timedOut) throw new Error('DevEngine never polled the edit')
        expect(result.value).toEqual([
          expect.objectContaining({
            update: expect.objectContaining({ type: 'Patch' }),
          }),
        ])
      } finally {
        await watcher.close()
      }
    },
    DEV_ENGINE_TEST_TIMEOUT_MS,
  )

  it(
    'refuses to refresh worker output while the latest source fails to build',
    async () => {
      const root = await createTempDir('neem-compiler-')
      const valueFile = resolve(root, 'api/value.ts')
      await mkdir(resolve(root, 'api'), { recursive: true })
      await writeFile(
        resolve(root, 'api/worker.ts'),
        "export { value as default } from './value.ts'\n",
      )
      await writeFile(valueFile, "export const value = 'v1'\n")
      const graph = createCompilerGraph(root)
      // DevEngine is real here; only the worker group is watched.
      const workerGraph = {
        ...graph,
        runtimes: [],
        buildGroups: graph.buildGroups.filter(
          (group) =>
            group.kind === 'target' && group.target.kind === 'runtime-worker',
        ),
      }
      let settled = createFuture<unknown>()
      const watcher = await watchGraph(workerGraph, {
        onUpdates: (_runtimeName, updates) => settled.resolve(updates),
        onUpdateError: (_runtimeName, error) => settled.resolve(error),
      })
      try {
        await watcher.addPatchClient('api', 'client')
        expect(
          await editUntilReported(
            valueFile,
            "export const value = 'v2'\n",
            () => settled.promise,
          ),
        ).toEqual([
          expect.objectContaining({
            update: expect.objectContaining({ type: 'Patch' }),
          }),
        ])

        settled = createFuture<unknown>()
        expect(
          await editUntilReported(
            valueFile,
            'export const value = !!!\n',
            () => settled.promise,
          ),
        ).toBeInstanceOf(Error)

        await expect(watcher.ensureWorkerOutput('api')).rejects.toThrow(
          'source has build errors',
        )
      } finally {
        await watcher.close()
      }
    },
    DEV_ENGINE_TEST_TIMEOUT_MS,
  )

  it(
    'fails only the update whose assets could not be written',
    async () => {
      const root = await createTempDir('neem-compiler-')
      const valueFile = resolve(root, 'api/value.ts')
      await mkdir(resolve(root, 'api'), { recursive: true })
      await writeFile(
        resolve(root, 'api/worker.ts'),
        "export { value as default } from './value.ts'\n",
      )
      await writeFile(valueFile, "export const value = 'v1'\n")
      const graph = createCompilerGraph(root)
      const workerGraph = {
        ...graph,
        runtimes: [],
        buildGroups: graph.buildGroups.filter(
          (group) =>
            group.kind === 'target' && group.target.kind === 'runtime-worker',
        ),
      }
      const worker = graph.targets.find(
        (target) => target.kind === 'runtime-worker',
      )!
      // Stands for a module that brings a file along, as a native addon does.
      worker.artifact.rolldown = {
        plugins: [
          {
            name: 'test:value-asset',
            transform(code, id) {
              if (!id.endsWith('value.ts')) return null
              this.emitFile({
                type: 'asset',
                fileName: 'value.txt',
                source: code,
              })
              return null
            },
          },
        ],
      }
      const assetFile = resolve(worker.outDir, 'value.txt')
      let settled = createFuture<unknown>()
      const errors: Error[] = []
      const watcher = await watchGraph(workerGraph, {
        onError: (error) => {
          errors.push(error)
        },
        onUpdates: (_runtimeName, updates) => settled.resolve(updates),
        onUpdateError: (_runtimeName, error) => settled.resolve(error),
      })
      try {
        await watcher.addPatchClient('api', 'client')
        // A directory in its place makes the asset write fail.
        await rm(assetFile, { force: true })
        await mkdir(assetFile)
        const failed = await editUntilReported(
          valueFile,
          "export const value = 'v2'\n",
          () => settled.promise,
        )
        expect(failed).toBeInstanceOf(Error)
        expect((failed as Error).message).toContain('assets were not written')
        expect(errors).toHaveLength(1)

        await rm(assetFile, { recursive: true })
        settled = createFuture<unknown>()
        expect(
          await editUntilReported(
            valueFile,
            "export const value = 'v3'\n",
            () => settled.promise,
          ),
        ).toEqual([
          expect.objectContaining({
            update: expect.objectContaining({ type: 'Patch' }),
          }),
        ])
        expect(await readFile(assetFile, 'utf8')).toContain('v3')
      } finally {
        await watcher.close()
      }
    },
    DEV_ENGINE_TEST_TIMEOUT_MS,
  )

  it('watches infra targets with one watcher and reports one rebuild for all infra metadata', async () => {
    const root = await createTempDir('neem-compiler-')
    const graph = createCompilerGraph(root, undefined, false)
    const watchers: Array<EventEmitter & { close: () => Promise<void> }> = []
    rolldownMock.watch.mockImplementation(() => {
      const watcher = createWatcher()
      watchers.push(watcher)
      return watcher
    })
    const onChange = vi.fn()

    const graphWatcher = await watchGraph(graph, { onChange })
    const watchOptions = findInfraOptions(rolldownMock.watch.mock.calls)
    const infraWatcherIndex = rolldownMock.watch.mock.calls.findIndex(
      ([options]) => options === watchOptions,
    )
    const infraWatcher = watchers[infraWatcherIndex]
    if (!infraWatcher) throw new Error('Expected infra watcher')
    expect(watchOptions.input).toEqual({
      start: entryPath(graph.startEntry),
      'worker-entry': entryPath(graph.workerEntry),
      'runner-entry': entryPath(graph.hostRunnerEntry),
    })

    emitBundle(infraWatcher, watchOptions, {
      'start.js': outputChunk('start.js', graph.startEntry),
      'worker-entry.js': outputChunk('worker-entry.js', graph.workerEntry),
      'runner-entry.js': outputChunk('runner-entry.js', graph.hostRunnerEntry),
    })
    for (
      let index = 0;
      index < rolldownMock.watch.mock.results.length;
      index++
    ) {
      if (index === infraWatcherIndex) continue
      const watcher = watchers[index]
      if (!watcher) throw new Error(`Missing watcher ${index}`)
      const targetOptions = rolldownMock.watch.mock.calls[
        index
      ]?.[0] as BuildOptions
      const target = graph.targets.find(
        (target) => target.artifact.entry === targetOptions.input,
      )
      if (!target) throw new Error(`Missing target ${index}`)
      emitBundle(watcher, targetOptions, {
        'index.js': outputChunk('index.js', target),
      })
    }

    const ready = await graphWatcher.ready

    expect(rolldownMock.watch).toHaveBeenCalledTimes(3)
    expect(ready.targets.map((target) => target.artifact.file)).toEqual([
      resolve(root, 'dist/runtime/start.js'),
      resolve(root, 'dist/runtime/worker-entry.js'),
      resolve(root, 'dist/runtime/runner-entry.js'),
      resolve(root, 'dist/runtime/api/host/index.js'),
      resolve(root, 'dist/runtime/api/planner/index.js'),
    ])

    const rebuiltResult = { close: vi.fn(async () => {}) }
    collectEntryMetadata(watchOptions, {
      'start.js': outputChunk('start.js', graph.startEntry),
      'worker-entry.js': outputChunk('worker-entry.js', graph.workerEntry),
      'runner-entry.js': outputChunk('runner-entry.js', graph.hostRunnerEntry),
    })
    infraWatcher.emit('event', { code: 'BUNDLE_END', result: rebuiltResult })
    infraWatcher.emit('event', { code: 'END' })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))

    const change = onChange.mock.calls[0]?.[0]
    expect(change.target).toBe(graph.startEntry)
    expect(
      change.compiledTargets.map((target) => target.artifact.file),
    ).toEqual([
      resolve(root, 'dist/runtime/start.js'),
      resolve(root, 'dist/runtime/worker-entry.js'),
      resolve(root, 'dist/runtime/runner-entry.js'),
    ])
    expect(
      graphWatcher
        .snapshot()
        .targets.slice(0, 3)
        .map((target) => target.artifact.file),
    ).toEqual([
      resolve(root, 'dist/runtime/start.js'),
      resolve(root, 'dist/runtime/worker-entry.js'),
      resolve(root, 'dist/runtime/runner-entry.js'),
    ])
    await vi.waitFor(() => expect(rebuiltResult.close).toHaveBeenCalledTimes(1))
  })
})

async function createTarget(): Promise<BuildTarget> {
  const root = await createTempDir('neem-compiler-')
  return {
    key: 'runtime:api:worker',
    kind: 'runtime-worker',
    artifact: {
      id: 'worker',
      kind: 'worker',
      entry: resolve(root, 'worker.ts'),
    },
    owner: { type: 'runtime', name: 'api' },
    outDir: resolve(root, 'dist'),
  }
}

function createCompilerGraph(
  root: string,
  build?: ReturnType<typeof createBuildGraph>['config']['build'],
  worker = true,
) {
  return createBuildGraph({
    configFile: resolve(root, 'neem.config.ts'),
    outDir: resolve(root, 'dist'),
    config: {
      build,
      runtimes: {
        api: {
          name: 'api',
          file: resolve(root, 'api/neem.runtime.ts'),
          directory: resolve(root, 'api'),
          planner: './planner.ts',
          declaration: defineRuntime({
            name: 'api',
            worker: worker ? { entry: './worker.ts' } : undefined,
            host: { entry: './host.ts' },
            planner: './planner.ts',
          }),
        },
      },
    },
  })
}

function fileWatcherOptions(options: BuildOptions) {
  const watch = options.watch
  if (!watch) throw new Error('watch options missing')
  return watch.watcher
}

function rolldownOutput(fileName: string, target: BuildTarget): RolldownOutput {
  return {
    output: [outputChunk(fileName, target)],
  } as unknown as RolldownOutput
}

function outputBundle(fileName: string, target: BuildTarget): OutputBundle {
  return {
    [fileName]: outputChunk(fileName, target),
  } as unknown as OutputBundle
}

function outputChunk(
  fileName: string,
  target: BuildTarget,
): OutputBundle[string] {
  return {
    type: 'chunk',
    fileName,
    isEntry: true,
    facadeModuleId: entryPath(target),
  } as unknown as OutputBundle[string]
}

function multiOutput(input: Record<string, unknown>): RolldownOutput['output'] {
  return Object.entries(input).map(([name, entry]) => ({
    type: 'chunk',
    fileName: `${name}.js`,
    isEntry: true,
    facadeModuleId: entry,
  })) as unknown as RolldownOutput['output']
}

function createWatcher(): EventEmitter & { close: () => Promise<void> } {
  const watcher = new EventEmitter() as EventEmitter & {
    close: () => Promise<void>
  }
  watcher.close = vi.fn(async () => {})
  return watcher
}

function emitBundle(
  watcher: EventEmitter,
  options: BuildOptions,
  bundle: OutputBundle,
): void {
  collectEntryMetadata(options, bundle)
  watcher.emit('event', { code: 'BUNDLE_END', result: { close: vi.fn() } })
  watcher.emit('event', { code: 'END' })
}

function collectEntryMetadata(
  options: BuildOptions,
  bundle: OutputBundle,
): void {
  const plugin = normalizePluginOptions(options.plugins).find(
    (plugin): plugin is Record<string, unknown> =>
      typeof plugin === 'object' &&
      plugin !== null &&
      'name' in plugin &&
      plugin.name === 'neem-entry-metadata',
  )
  const handler = getHookHandler(plugin?.writeBundle ?? plugin?.generateBundle)
  if (!handler) throw new Error('Expected Neem metadata plugin hook')

  handler.call({}, {}, bundle)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findInfraOptions(calls: unknown[][]): BuildOptions {
  const options = calls.find(([options]) =>
    isRecord((options as BuildOptions | undefined)?.input),
  )?.[0] as BuildOptions | undefined
  if (!options) throw new Error('Expected infra build options')
  return options
}

function entryPath(target: BuildTarget): string {
  const entry = target.artifact.entry
  return entry instanceof URL ? fileURLToPath(entry) : entry
}

function getCodeSplittingGroups(options: BuildOptions): readonly unknown[] {
  const output = options.output as {
    codeSplitting?: { groups?: readonly unknown[] }
  }
  return output.codeSplitting?.groups ?? []
}

function normalizePluginOptions(
  plugins: BuildOptions['plugins'] | undefined,
): unknown[] {
  if (!plugins) return []
  return Array.isArray(plugins) ? plugins : [plugins]
}

function getHookHandler(
  hook: unknown,
): ((...args: readonly unknown[]) => unknown) | undefined {
  if (typeof hook === 'function') {
    return hook as unknown as (...args: readonly unknown[]) => unknown
  }
  if (
    typeof hook === 'object' &&
    hook !== null &&
    'handler' in hook &&
    typeof hook.handler === 'function'
  ) {
    return hook.handler as unknown as (...args: readonly unknown[]) => unknown
  }
  return undefined
}
