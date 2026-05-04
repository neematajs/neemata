import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  NeemArtifact,
  NeemArtifactOwner,
  NeemResolvedArtifact,
  NeemRolldownOptions,
} from '../public/artifact.ts'

type RolldownOutputChunk = {
  type?: string
  fileName?: string
  isEntry?: boolean
}

type RolldownOutput = { output?: RolldownOutputChunk[] }

type RolldownWatcher = {
  on: (event: 'event', listener: (event: any) => void | Promise<void>) => void
  close: () => Promise<void>
}

type RolldownModule = {
  build: (options: Record<string, unknown>) => Promise<RolldownOutput>
  watch: (options: Record<string, unknown>) => RolldownWatcher
}

export type NeemBuildArtifactOptions = {
  artifact: NeemArtifact
  owner: NeemArtifactOwner
  rolldown?: NeemRolldownOptions
  cwd?: string
  outDir: string
  sourcemap?: boolean
  minify?: boolean
}

export type NeemWatchArtifactHandlers = {
  onRebuild?: (
    artifact: NeemResolvedArtifact,
    event: unknown,
  ) => void | Promise<void>
  onError?: (error: unknown, event: unknown) => void | Promise<void>
}

export type NeemArtifactWatcher = { close: () => Promise<void> }

export async function buildArtifact(
  options: NeemBuildArtifactOptions,
): Promise<NeemResolvedArtifact> {
  const rolldown = await loadRolldown()
  const outDir = resolveArtifactOutDir(options)
  await mkdir(outDir, { recursive: true })

  const result = await rolldown.build(createRolldownOptions(options, outDir))

  return createResolvedArtifact(options, outDir, result)
}

export async function watchArtifact(
  options: NeemBuildArtifactOptions,
  handlers: NeemWatchArtifactHandlers,
): Promise<NeemArtifactWatcher> {
  const rolldown = await loadRolldown()
  const outDir = resolveArtifactOutDir(options)
  await mkdir(outDir, { recursive: true })

  const watcher = rolldown.watch(createRolldownOptions(options, outDir))

  watcher.on('event', async (event: any) => {
    if (event?.code === 'BUNDLE_END') {
      try {
        const resolved = createResolvedArtifact(options, outDir, event.result)
        await handlers.onRebuild?.(resolved, event)
      } finally {
        await event.result?.close?.()
      }
      return
    }

    if (event?.code === 'ERROR') {
      await handlers.onError?.(event.error, event)
    }
  })

  return { close: () => watcher.close() }
}

async function loadRolldown(): Promise<RolldownModule> {
  return (await import('rolldown')) as RolldownModule
}

function createRolldownOptions(
  options: NeemBuildArtifactOptions,
  outDir: string,
): Record<string, unknown> {
  const userOptions = mergeRolldownOptions(
    options.rolldown,
    options.artifact.rolldown,
  )
  const userOutput =
    typeof userOptions.output === 'object' && userOptions.output
      ? (userOptions.output as Record<string, unknown>)
      : {}

  return {
    ...userOptions,
    input: resolveEntry(options.artifact.entry, options.cwd),
    platform: 'node',
    output: {
      ...userOutput,
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name]-[hash].js',
      chunkFileNames: '[name]-[hash].js',
      assetFileNames: '[name]-[hash][extname]',
      sourcemap: options.sourcemap ?? true,
      minify: options.minify ?? false,
    },
  }
}

function createResolvedArtifact(
  options: NeemBuildArtifactOptions,
  outDir: string,
  result: RolldownOutput | undefined,
): NeemResolvedArtifact {
  const entryChunk = result?.output?.find(
    (chunk) => chunk.type === 'chunk' && chunk.isEntry && chunk.fileName,
  )

  return {
    id: options.artifact.id,
    kind: options.artifact.kind,
    owner: options.owner,
    file: entryChunk?.fileName
      ? resolve(outDir, entryChunk.fileName)
      : resolve(outDir, 'index.js'),
    outDir,
  }
}

function resolveArtifactOutDir(options: NeemBuildArtifactOptions): string {
  if (options.owner.type === 'config') {
    return resolve(
      options.outDir,
      'config',
      sanitizePathPart(options.artifact.id),
    )
  }

  const owner =
    options.owner.type === 'plugin'
      ? `${options.owner.instanceId}-${options.owner.name}`
      : options.owner.name

  return resolve(
    options.outDir,
    options.owner.type === 'plugin' ? 'plugins' : 'apps',
    sanitizePathPart(owner),
    sanitizePathPart(options.artifact.id),
  )
}

function resolveEntry(entry: string | URL, cwd = process.cwd()): string {
  if (entry instanceof URL) return fileURLToPath(entry)
  return resolve(cwd, entry)
}

function sanitizePathPart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
}

function mergeRolldownOptions(
  base: NeemRolldownOptions | undefined,
  override: NeemRolldownOptions | undefined,
): NeemRolldownOptions {
  const baseOutput =
    typeof base?.output === 'object' && base.output
      ? (base.output as Record<string, unknown>)
      : {}
  const overrideOutput =
    typeof override?.output === 'object' && override.output
      ? (override.output as Record<string, unknown>)
      : {}

  return {
    ...(base ?? {}),
    ...(override ?? {}),
    output: { ...baseOutput, ...overrideOutput },
  }
}
