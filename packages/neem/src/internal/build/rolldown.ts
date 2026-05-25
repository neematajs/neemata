import { mkdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as rolldown from 'rolldown'

import type {
  NeemArtifact,
  NeemArtifactOwner,
  NeemResolvedArtifact,
  NeemRolldownOptions,
} from '../../public/artifact.ts'

type ArtifactBuildMetadata = {
  entryFileName?: string
  emittedArtifacts?: EmittedArtifactBuildMetadata[]
}

type EmittedArtifactBuildMetadata = {
  id: string
  kind: NeemArtifact['kind']
  fileName: string
}

export type NeemBuildArtifactOptions = {
  artifact: NeemArtifact
  owner: NeemArtifactOwner
  rolldown?: NeemRolldownOptions
  cwd?: string
  outDir: string
  artifactOutDir?: string
  emittedArtifacts?: readonly NeemArtifact[]
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

  watcher.on('event', async (event) => {
    if (event?.code === 'START') {
      return
    }

    if (event?.code === 'BUNDLE_START') {
      return
    }

    if (event?.code === 'BUNDLE_END') {
      try {
        const resolved = createResolvedArtifact(
          options,
          outDir,
          undefined,
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

  return {
    ready,
    async close() {
      await watcher.close()
    },
  }
}

function createRolldownOptions(
  options: NeemBuildArtifactOptions,
  outDir: string,
  metadata: ArtifactBuildMetadata,
): rolldown.BuildOptions {
  const userOptions = mergeRolldownOptions(
    options.rolldown,
    options.artifact.rolldown,
  )
  const userOutput =
    typeof userOptions.output === 'object' && userOptions.output
      ? (userOptions.output as Record<string, unknown>)
      : {}
  const userPlugins = normalizePlugins(userOptions.plugins)

  const input = resolveEntry(options.artifact.entry, options.cwd)

  return {
    input,
    platform: 'node',
    ...userOptions,
    plugins: [
      createNativeAddonPlugin(),
      ...userPlugins,
      createEmittedArtifactsPlugin(
        options.emittedArtifacts ?? [],
        metadata,
        options.cwd,
      ),
      createEntryMetadataPlugin(input, metadata),
    ],
    output: {
      sourcemap: options.sourcemap ?? true,
      minify: options.minify ?? false,
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name]-[hash].js',
      chunkFileNames: '[name]-[hash].js',
      assetFileNames: '[name]-[hash][extname]',
      ...userOutput,
    },
  }
}

function createResolvedArtifact(
  options: NeemBuildArtifactOptions,
  outDir: string,
  result: rolldown.RolldownOutput | undefined,
  metadata: ArtifactBuildMetadata,
): NeemResolvedArtifact {
  const entryChunk = result?.output?.find(
    (chunk) =>
      chunk.type === 'chunk' &&
      chunk.isEntry &&
      chunk.fileName &&
      chunk.facadeModuleId ===
        resolveEntry(options.artifact.entry, options.cwd),
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
    bundle: result,
    emittedArtifacts: metadata.emittedArtifacts?.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      owner: options.owner,
      file: resolve(outDir, artifact.fileName),
      outDir,
    })),
  }
}

function normalizePlugins(
  value: rolldown.RolldownPluginOption,
): rolldown.RolldownPluginOption[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function createEntryMetadataPlugin(
  input: string,
  metadata: ArtifactBuildMetadata,
): rolldown.RolldownPlugin {
  return {
    name: 'neem-entry-metadata',
    generateBundle(_options, bundle) {
      const entryChunk = Object.values(bundle).find(
        (chunk) =>
          chunk.type === 'chunk' &&
          chunk.isEntry &&
          chunk.fileName &&
          chunk.facadeModuleId === input,
      )
      metadata.entryFileName = entryChunk?.fileName
    },
  } satisfies rolldown.RolldownPlugin
}

function createEmittedArtifactsPlugin(
  artifacts: readonly NeemArtifact[],
  metadata: ArtifactBuildMetadata,
  cwd: string | undefined,
): rolldown.RolldownPlugin {
  let emitted: Array<{ artifact: NeemArtifact; referenceId: string }> = []

  return {
    name: 'neem:emitted-artifacts',
    buildStart() {
      emitted = artifacts.map((artifact) => ({
        artifact,
        referenceId: this.emitFile({
          type: 'chunk',
          id: resolveEntry(artifact.entry, cwd),
          name: artifact.id,
        }),
      }))
    },
    generateBundle() {
      metadata.emittedArtifacts = emitted.map(({ artifact, referenceId }) => ({
        id: artifact.id,
        kind: artifact.kind,
        fileName: this.getFileName(referenceId),
      }))
    },
  } satisfies rolldown.RolldownPlugin
}

function createNativeAddonPlugin() {
  return {
    name: 'neem:native-addon',
    async load(this: rolldown.PluginContext, id: string) {
      const isNapi = id.endsWith('.node')
      const accessible = await this.fs.stat(id).then(
        () => true,
        () => false,
      )
      if (!isNapi || !accessible) return null
      return await emitNativeAddonModule(this, id)
    },
  } satisfies rolldown.RolldownPlugin
}

async function emitNativeAddonModule(
  context: rolldown.PluginContext,
  file: string,
): Promise<string> {
  const refId = context.emitFile({
    type: 'asset',
    name: basename(file),
    source: await context.fs.readFile(file),
  })

  const runtimePath = `./${context.getFileName(refId)}`

  return [
    'import { createRequire } from "node:module"',
    'const require = createRequire(import.meta.url)',
    `export default require(${JSON.stringify(runtimePath)})`,
  ].join('\n')
}

function resolveArtifactOutDir(options: NeemBuildArtifactOptions): string {
  if (options.artifactOutDir) return options.artifactOutDir

  if (options.owner.type === 'runtime') {
    return resolve(
      options.outDir,
      'runtime',
      sanitizePathPart(options.owner.name),
    )
  }

  if (options.owner.type === 'config') {
    return resolve(
      options.outDir,
      'config',
      sanitizePathPart(options.artifact.id),
    )
  }

  return resolve(options.outDir, sanitizePathPart(options.artifact.id))
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
  const plugins = [
    ...normalizePlugins(base?.plugins),
    ...normalizePlugins(override?.plugins),
  ]
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
    plugins: plugins.length > 0 ? plugins : undefined,
  }
}
