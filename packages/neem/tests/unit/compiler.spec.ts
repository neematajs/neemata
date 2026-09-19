import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BuildOptions, OutputBundle } from 'rolldown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuildGroup, BuildTarget } from '../../src/internal/build/graph.ts'
import {
  compileGraph,
  compileTargets,
  watchGraph,
  watchTargets,
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
      collectEntryMetadata(options, entryBundle(options))
    })

    const compiled = await compileGraph(graph)

    expect(rolldownMock.build).toHaveBeenCalledTimes(4)
    const infraOptions = findInfraOptions(rolldownMock.build.mock.calls)
    expect(infraOptions.input).toEqual({
      start: entryPath(target(graph, 'start-entry')),
      'worker-entry': entryPath(target(graph, 'worker-entry')),
      'runner-entry': entryPath(target(graph, 'host-runner-entry')),
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
    expect(depsGroup.test(entryPath(target(graph, 'worker-entry')))).toBe(false)
    expect(depsGroup.test(entryPath(target(graph, 'host-runner-entry')))).toBe(
      false,
    )
    expect(depsGroup.test(entryPath(target(graph, 'start-entry')))).toBe(false)
    expect(compiled.targets.map((compiled) => compiled.artifact.file)).toEqual([
      resolve(root, 'dist/runtime/start.js'),
      resolve(root, 'dist/runtime/worker-entry.js'),
      resolve(root, 'dist/runtime/runner-entry.js'),
      resolve(root, 'dist/runtime/api/worker/worker.js'),
      resolve(root, 'dist/runtime/api/host/host.js'),
      resolve(root, 'dist/runtime/api/planner/planner.js'),
    ])
  })

  it('resolves the compiled entry file from the emitted bundle', async () => {
    const group = await createGroup()
    rolldownMock.build.mockImplementation(async (options: BuildOptions) => {
      collectEntryMetadata(options, entryBundle(options, 'compiled-entry.js'))
    })

    const [compiled] = await compileTargets(group)
    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions

    expect(compiled?.artifact.file).toBe(
      resolve(group.targets[0]!.outDir, 'compiled-entry.js'),
    )
    expect(options.treeshake).toBeUndefined()
    expect(options.output).toMatchObject({
      entryFileNames: '[name]-[hash].js',
    })
  })

  it('fails when a build emits no entry chunk for a target', async () => {
    const group = await createGroup()
    rolldownMock.build.mockResolvedValue(undefined)

    await expect(compileTargets(group)).rejects.toThrow(
      'Neem build emitted no entry chunk for [runtime:api:worker]',
    )
  })

  it('appends default deps chunk group after user chunk groups', async () => {
    const group = await createGroup()
    const localGroup = { name: 'local', test: /perf-large-ts-modules/ }
    group.targets[0]!.artifact.chunks = { groups: [localGroup] }
    rolldownMock.build.mockImplementation(async (options: BuildOptions) => {
      collectEntryMetadata(options, entryBundle(options))
    })

    await compileTargets(group)

    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
    expect(options.output).toMatchObject({
      codeSplitting: {
        groups: [localGroup, { name: 'deps', test: /node_modules/ }],
      },
    })
  })

  it('lets a user deps chunk group replace the default deps group', async () => {
    const group = await createGroup()
    const depsGroup = { name: 'deps', test: /node_modules\/zod/ }
    group.targets[0]!.artifact.chunks = { groups: [depsGroup] }
    rolldownMock.build.mockImplementation(async (options: BuildOptions) => {
      collectEntryMetadata(options, entryBundle(options))
    })

    await compileTargets(group)

    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
    expect(options.output).toMatchObject({
      codeSplitting: { groups: [depsGroup] },
    })
  })

  it('disables code splitting when chunks is false', async () => {
    const group = await createGroup()
    group.targets[0]!.artifact.chunks = false
    rolldownMock.build.mockImplementation(async (options: BuildOptions) => {
      collectEntryMetadata(options, entryBundle(options))
    })

    await compileTargets(group)

    const options = rolldownMock.build.mock.calls[0]?.[0] as BuildOptions
    expect((options.output as { codeSplitting?: unknown }).codeSplitting).toBe(
      undefined,
    )
  })

  it('uses the watcher initial build as ready output', async () => {
    const group = await createGroup()
    rolldownMock.build.mockResolvedValue(undefined)
    const watcher = createWatcher()
    rolldownMock.watch.mockReturnValue(watcher)

    const groupWatcher = await watchTargets(group)
    const watchOptions = rolldownMock.watch.mock.calls[0]?.[0] as BuildOptions
    collectEntryMetadata(watchOptions, entryBundle(watchOptions, 'watch.js'))

    const initialResult = { close: vi.fn(async () => {}) }
    watcher.emit('event', { code: 'BUNDLE_END', result: initialResult })
    watcher.emit('event', { code: 'END' })

    const [compiled] = await groupWatcher.ready

    expect(rolldownMock.build).not.toHaveBeenCalled()
    expect(compiled?.artifact.file).toBe(
      resolve(group.targets[0]!.outDir, 'watch.js'),
    )
    expect(watchOptions.output).toMatchObject({ entryFileNames: '[name].js' })
    expect(initialResult.close).toHaveBeenCalledTimes(1)
  })

  it('does not set a default watcher build delay', async () => {
    const group = await createGroup()
    rolldownMock.watch.mockReturnValue(createWatcher())

    await watchTargets(group)

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
      watch: { buildDelay: 125, debounceDelay: 25 },
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
      start: entryPath(target(graph, 'start-entry')),
      'worker-entry': entryPath(target(graph, 'worker-entry')),
      'runner-entry': entryPath(target(graph, 'host-runner-entry')),
    })

    for (const [index, watcher] of watchers.entries()) {
      const options = rolldownMock.watch.mock.calls[index]?.[0] as BuildOptions
      emitBundle(watcher, options)
    }

    const ready = await graphWatcher.ready

    expect(rolldownMock.watch).toHaveBeenCalledTimes(4)
    expect(ready.targets.map((target) => target.artifact.file)).toEqual([
      resolve(root, 'dist/runtime/start.js'),
      resolve(root, 'dist/runtime/worker-entry.js'),
      resolve(root, 'dist/runtime/runner-entry.js'),
      resolve(root, 'dist/runtime/api/worker/worker.js'),
      resolve(root, 'dist/runtime/api/host/host.js'),
      resolve(root, 'dist/runtime/api/planner/planner.js'),
    ])

    const rebuiltResult = { close: vi.fn(async () => {}) }
    collectEntryMetadata(watchOptions, entryBundle(watchOptions))
    infraWatcher.emit('event', { code: 'BUNDLE_END', result: rebuiltResult })
    infraWatcher.emit('event', { code: 'END' })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))

    const change = onChange.mock.calls[0]?.[0]
    expect(
      change.targets.map(
        (target: { artifact: { file: string } }) => target.artifact.file,
      ),
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

async function createGroup(): Promise<BuildGroup> {
  const root = await useTempDir()
  return {
    kind: 'artifact',
    targets: [
      {
        key: 'runtime:api:worker',
        kind: 'runtime-worker',
        entryName: 'worker',
        artifact: {
          id: 'worker',
          kind: 'worker',
          entry: resolve(root, 'worker.ts'),
          rolldown: {},
        },
        owner: { type: 'runtime', name: 'api' },
        outDir: resolve(root, 'dist'),
      },
    ],
  }
}

async function useTempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'neem-compiler-'))
  tempDirs.push(root)
  return root
}

function createCompilerGraph(
  root: string,
  build?: ReturnType<typeof createBuildGraph>['config']['build'],
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
          planner: resolve(root, 'api/planner.ts'),
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

function target(
  graph: ReturnType<typeof createBuildGraph>,
  kind: BuildTarget['kind'],
): BuildTarget {
  const found = graph.targets.find((target) => target.kind === kind)
  if (!found) throw new Error(`Missing ${kind} target`)
  return found
}

// Mirrors what rolldown emits for the configured inputs: one entry chunk per
// input, named after its input key unless the test pins a file name.
function entryBundle(options: BuildOptions, fileName?: string): OutputBundle {
  const inputs = options.input as Record<string, string>
  const bundle: Record<string, unknown> = {}
  for (const [name, file] of Object.entries(inputs)) {
    const chunkFileName = fileName ?? `${name}.js`
    bundle[chunkFileName] = {
      type: 'chunk',
      fileName: chunkFileName,
      isEntry: true,
      facadeModuleId: file,
    }
  }
  return bundle as unknown as OutputBundle
}

function createWatcher(): EventEmitter & { close: () => Promise<void> } {
  const watcher = new EventEmitter() as EventEmitter & {
    close: () => Promise<void>
  }
  watcher.close = vi.fn(async () => {})
  return watcher
}

function emitBundle(watcher: EventEmitter, options: BuildOptions): void {
  collectEntryMetadata(options, entryBundle(options))
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
  const options = calls.find(([options]) => {
    const input = (options as BuildOptions | undefined)?.input
    return isRecord(input) && Object.keys(input).length > 1
  })?.[0] as BuildOptions | undefined
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
