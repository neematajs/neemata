import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import type { BuildOptions, OutputBundle, RolldownOutput } from 'rolldown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuildTarget } from '../../src/internal/build/graph.ts'
import {
  compileTarget,
  watchTarget,
} from '../../src/internal/build/compiler.ts'

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
})

async function createTarget(): Promise<BuildTarget> {
  const root = await mkdtemp(resolve(tmpdir(), 'neem-compiler-'))
  tempDirs.push(root)
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

function outputChunk(fileName: string, target: BuildTarget) {
  return {
    type: 'chunk',
    fileName,
    isEntry: true,
    facadeModuleId: target.artifact.entry,
  }
}

function createWatcher(): EventEmitter & { close: () => Promise<void> } {
  const watcher = new EventEmitter() as EventEmitter & {
    close: () => Promise<void>
  }
  watcher.close = vi.fn(async () => {})
  return watcher
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
