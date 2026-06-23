import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BuildOptions, OutputBundle, RolldownOutput } from 'rolldown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuildTarget } from '../../src/internal/build/graph.ts'
import {
  compileGraph,
  compileTarget,
  watchGraph,
  watchTarget,
} from '../../src/internal/build/compiler.ts'
import { createBuildGraph } from '../../src/internal/build/graph.ts'
import { defineRuntime } from '../../src/public/config.ts'

const rolldownMock = vi.hoisted(() => ({ build: vi.fn(), watch: vi.fn() }))

vi.mock('rolldown', () => rolldownMock)

const tempDirs: string[] = []

beforeEach(() => {
  rolldownMock.build.mockReset()
  rolldownMock.watch.mockReset()
})

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('Neem compiler', () => {
  it('compiles infra targets with one multi-entry rolldown build', async () => {
    const root = await useTempDir()
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

    expect(compiled.artifact.file).toBe(
      resolve(target.outDir, 'compiled-entry.js'),
    )
    expect(compiled.bundle).toBeUndefined()
    expect(compiled.artifact.bundle).toBeUndefined()
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
    const depsGroup = { name: 'deps', test: /node_modules\/bullmq/ }
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
    expect(compiled.artifact.bundle).toBeUndefined()
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
    const root = await useTempDir()
    const graph = createCompilerGraph(root, {
      build: { watch: { buildDelay: 125, debounceDelay: 25 } },
    })
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

  it('watches infra targets with one watcher and reports one rebuild for all infra metadata', async () => {
    const root = await useTempDir()
    const graph = createCompilerGraph(root)
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
      let index = 1;
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

    expect(rolldownMock.watch).toHaveBeenCalledTimes(4)
    expect(ready.targets.map((target) => target.artifact.file)).toEqual([
      resolve(root, 'dist/runtime/start.js'),
      resolve(root, 'dist/runtime/worker-entry.js'),
      resolve(root, 'dist/runtime/runner-entry.js'),
      resolve(root, 'dist/runtime/api/worker/index.js'),
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
  const root = await useTempDir()
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

async function useTempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'neem-compiler-'))
  tempDirs.push(root)
  return root
}

function createCompilerGraph(
  root: string,
  options: { build?: ReturnType<typeof createBuildGraph>['config']['build'] } = {},
) {
  return createBuildGraph({
    configFile: resolve(root, 'neem.config.ts'),
    outDir: resolve(root, 'dist'),
    config: {
      build: options.build,
      runtimes: {
        api: {
          name: 'api',
          file: resolve(root, 'api/neem.runtime.ts'),
          directory: resolve(root, 'api'),
          planner: './planner.ts',
          declaration: defineRuntime({
            name: 'api',
            worker: { entry: './worker.ts' },
            host: { entry: './host.ts' },
            planner: './planner.ts',
          }),
        },
      },
    },
  })
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
