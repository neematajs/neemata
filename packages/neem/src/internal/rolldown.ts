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

type ArtifactBuildMetadata = { entryFileName?: string }

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

export type NeemArtifactWatcher = {
  ready: Promise<NeemResolvedArtifact>
  close: () => Promise<void>
}

export async function buildArtifact(
  options: NeemBuildArtifactOptions,
): Promise<NeemResolvedArtifact> {
  const rolldown = await loadRolldown()
  const outDir = resolveArtifactOutDir(options)
  const metadata: ArtifactBuildMetadata = {}
  await mkdir(outDir, { recursive: true })

  const result = await rolldown.build(
    createRolldownOptions(options, outDir, metadata),
  )

  return createResolvedArtifact(options, outDir, result, metadata)
}

export async function watchArtifact(
  options: NeemBuildArtifactOptions,
  handlers: NeemWatchArtifactHandlers,
): Promise<NeemArtifactWatcher> {
  const rolldown = await loadRolldown()
  const outDir = resolveArtifactOutDir(options)
  const metadata: ArtifactBuildMetadata = {}
  await mkdir(outDir, { recursive: true })

  const watcher = rolldown.watch(
    createRolldownOptions(options, outDir, metadata),
  )
  let readySettled = false
  let resolveReady!: (artifact: NeemResolvedArtifact) => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<NeemResolvedArtifact>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  watcher.on('event', async (event: any) => {
    if (event?.code === 'BUNDLE_END') {
      try {
        const resolved = createResolvedArtifact(
          options,
          outDir,
          event.result,
          metadata,
        )
        if (!readySettled) {
          readySettled = true
          resolveReady(resolved)
        }
        await handlers.onRebuild?.(resolved, event)
      } finally {
        await event.result?.close?.()
      }
      return
    }

    if (event?.code === 'ERROR') {
      if (!readySettled) {
        readySettled = true
        rejectReady(event.error)
      }
      await handlers.onError?.(event.error, event)
    }
  })

  return { ready, close: () => watcher.close() }
}

async function loadRolldown(): Promise<RolldownModule> {
  return (await import('rolldown')) as RolldownModule
}

function createRolldownOptions(
  options: NeemBuildArtifactOptions,
  outDir: string,
  metadata: ArtifactBuildMetadata,
): Record<string, unknown> {
  const userOptions = mergeRolldownOptions(
    options.rolldown,
    options.artifact.rolldown,
  )
  const userOutput =
    typeof userOptions.output === 'object' && userOptions.output
      ? (userOptions.output as Record<string, unknown>)
      : {}
  const userPlugins = normalizePlugins(userOptions.plugins)

  return {
    ...userOptions,
    input: resolveEntry(options.artifact.entry, options.cwd),
    platform: 'node',
    plugins: [...userPlugins, createEntryMetadataPlugin(metadata)],
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
  metadata: ArtifactBuildMetadata,
): NeemResolvedArtifact {
  const entryChunk = result?.output?.find(
    (chunk) => chunk.type === 'chunk' && chunk.isEntry && chunk.fileName,
  )
  const entryFileName = metadata.entryFileName ?? entryChunk?.fileName

  return {
    id: options.artifact.id,
    kind: options.artifact.kind,
    owner: options.owner,
    file: entryFileName
      ? resolve(outDir, entryFileName)
      : resolve(outDir, 'index.js'),
    outDir,
  }
}

function normalizePlugins(value: unknown): unknown[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function createEntryMetadataPlugin(
  metadata: ArtifactBuildMetadata,
): Record<string, unknown> {
  return {
    name: 'neem-entry-metadata',
    generateBundle(
      _options: unknown,
      bundle: Record<string, RolldownOutputChunk>,
    ) {
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === 'chunk' && chunk.isEntry && chunk.fileName,
      )
      metadata.entryFileName = entryChunk?.fileName
    },
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
