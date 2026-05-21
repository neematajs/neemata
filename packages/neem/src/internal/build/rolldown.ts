import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as rolldown from 'rolldown'

import type {
  NeemArtifact,
  NeemArtifactOwner,
  NeemResolvedArtifact,
  NeemRolldownOptions,
} from '../../public/artifact.ts'

type ArtifactBuildMetadata = { entryFileName?: string }

type NeemRolldownPluginContext = {
  emitFile: (emittedFile: {
    type: 'asset'
    name: string
    source: Buffer
  }) => string
  getFileName: (referenceId: string) => string
}

export type NeemBuildArtifactOptions = {
  artifact: NeemArtifact
  owner: NeemArtifactOwner
  rolldown?: NeemRolldownOptions
  cwd?: string
  outDir: string
  artifactOutDir?: string
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

  return {
    input: resolveEntry(options.artifact.entry, options.cwd),
    platform: 'node',
    ...userOptions,
    plugins: [
      createNativeAddonPlugin(),
      createUwsNativeAddonPlugin(),
      ...userPlugins,
      createEntryMetadataPlugin(metadata),
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
    bundle: result,
  }
}

function normalizePlugins(
  value: rolldown.RolldownPluginOption,
): rolldown.RolldownPluginOption[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function createEntryMetadataPlugin(
  metadata: ArtifactBuildMetadata,
): rolldown.RolldownPlugin {
  return {
    name: 'neem-entry-metadata',
    generateBundle(_options, bundle) {
      const entryChunk = Object.values(bundle).find(
        (chunk) => chunk.type === 'chunk' && chunk.isEntry && chunk.fileName,
      )
      metadata.entryFileName = entryChunk?.fileName
    },
  } satisfies rolldown.RolldownPlugin
}

function createNativeAddonPlugin() {
  return {
    name: 'neem:native-addon',
    async load(this: NeemRolldownPluginContext, id: string) {
      if (!id.endsWith('.node') || !existsSync(id)) return null
      return await emitNativeAddonModule(this, id)
    },
  } satisfies rolldown.RolldownPlugin
}

function createUwsNativeAddonPlugin() {
  return {
    name: 'neem:uws-native-addon',
    async load(this: NeemRolldownPluginContext, id: string) {
      if (!id.includes('uWebSockets.js/uws.js')) return null
      const nativeAddon = join(
        dirname(id),
        `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
      )
      return await emitNativeAddonModule(this, nativeAddon)
    },
    async transform(
      this: NeemRolldownPluginContext,
      _code: string,
      id: string,
    ) {
      if (!id.includes('uWebSockets.js/uws.js')) return null
      const nativeAddon = join(
        dirname(id),
        `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
      )
      return await emitNativeAddonModule(this, nativeAddon)
    },
  } satisfies rolldown.RolldownPlugin
}

async function emitNativeAddonModule(
  context: NeemRolldownPluginContext,
  file: string,
): Promise<string> {
  const refId = context.emitFile({
    type: 'asset',
    name: basename(file),
    source: await readFile(file),
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
