import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { transform } from 'rolldown/utils'

import type { NeemResolvedArtifact } from '../public/artifact.ts'
import type {
  NeemBuildConfig,
  NeemBuildConfigInput,
  NeemConfig,
} from '../public/config.ts'
import type { NeemPlugin } from '../public/plugin.ts'
import { discoverConfigEntriesSync } from './discovery.ts'
import { buildArtifact } from './rolldown.ts'

export const NEEM_MANIFEST_FILE = 'neem.manifest.json'
export const NEEM_MANIFEST_SCHEMA_VERSION = 1

export type NeemBuildOptions = {
  config?: string
  outDir?: string
  cwd?: string
}

export type NeemBuildManifestArtifact = {
  id: string
  kind: string
  owner: NeemResolvedArtifact['owner']
  file: string
  outDir: string
}

export type NeemBuildManifest = {
  schemaVersion: typeof NEEM_MANIFEST_SCHEMA_VERSION
  config: { file: string }
  apps: Record<string, { name: string; entry: NeemBuildManifestArtifact }>
  plugins: Array<{
    index: number
    name: string
    entry: NeemBuildManifestArtifact
    artifacts: NeemBuildManifestArtifact[]
  }>
}

export type NeemBuildResult = {
  configFile: string
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
}

type EntryModule<T> = { default: T }

export async function buildNeem(
  options: NeemBuildOptions = {},
): Promise<NeemBuildResult> {
  const cwd = options.cwd ?? process.cwd()
  const configFile = resolve(cwd, options.config ?? 'neem.config.ts')
  const discovery = discoverConfigEntriesSync(configFile)
  const config = await importDefault<NeemConfig>(configFile)
  const outDir = resolve(cwd, options.outDir ?? config.outDir ?? 'dist')

  await cleanNeemOutDir(outDir)
  await mkdir(outDir, { recursive: true })

  const configArtifact = await transformConfig({ configFile, cwd, outDir })

  const manifest: NeemBuildManifest = {
    schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
    config: { file: toManifestPath(outDir, configArtifact.file) },
    apps: {},
    plugins: [],
  }

  for (const [name, appConfig] of Object.entries(config.apps)) {
    const discovered = discovery.apps[name]
    if (!discovered) {
      throw new Error(`Failed to discover app entry for [${name}]`)
    }

    await appConfig.entry()
    const rolldown = await loadBuildConfig(appConfig.build)
    const entry = await buildArtifact({
      artifact: {
        id: 'entry',
        kind: 'module',
        entry: discovered.entry.resolved,
      },
      owner: { type: 'app', name },
      rolldown,
      outDir,
    })

    manifest.apps[name] = { name, entry: toManifestArtifact(outDir, entry) }
  }

  for (const [index, pluginConfig] of (config.plugins ?? []).entries()) {
    const discovered = discovery.plugins[index]
    if (!discovered) {
      throw new Error(`Failed to discover plugin entry for index [${index}]`)
    }

    const plugin = (await pluginConfig.entry()).default as NeemPlugin<any>
    const pluginName = plugin.name
    const rolldown = await loadBuildConfig(pluginConfig.build)
    const owner = {
      type: 'plugin' as const,
      name: pluginName,
      instanceId: index,
    }

    const entry = await buildArtifact({
      artifact: {
        id: 'entry',
        kind: 'module',
        entry: discovered.entry.resolved,
      },
      owner,
      rolldown,
      outDir,
    })

    const declaredArtifacts =
      (await plugin.artifacts?.({
        mode: 'production',
        name: pluginName,
        instanceId: index,
        options: pluginConfig.options,
      })) ?? []

    const artifacts: NeemBuildManifestArtifact[] = []
    for (const artifact of declaredArtifacts) {
      const built = await buildArtifact({
        artifact,
        owner,
        rolldown,
        cwd: dirname(discovered.entry.resolved),
        outDir,
      })
      artifacts.push(toManifestArtifact(outDir, built))
    }

    manifest.plugins.push({
      index,
      name: pluginName,
      entry: toManifestArtifact(outDir, entry),
      artifacts,
    })
  }

  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  await writeFile(
    `${manifestFile}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await rename(`${manifestFile}.tmp`, manifestFile)

  return { configFile, outDir, manifestFile, manifest }
}

async function cleanNeemOutDir(outDir: string): Promise<void> {
  await Promise.all([
    rm(resolve(outDir, 'config'), { recursive: true, force: true }),
    rm(resolve(outDir, 'apps'), { recursive: true, force: true }),
    rm(resolve(outDir, 'plugins'), { recursive: true, force: true }),
    rm(resolve(outDir, NEEM_MANIFEST_FILE), { force: true }),
  ])
}

async function transformConfig(options: {
  configFile: string
  cwd: string
  outDir: string
}): Promise<NeemResolvedArtifact> {
  const configOutDir = resolve(options.outDir, 'config', 'entry')
  const outputFile = resolve(
    configOutDir,
    `${basename(options.configFile, extname(options.configFile))}.js`,
  )
  const source = await readFile(options.configFile, 'utf8')
  const result = await transform(options.configFile, source, {
    cwd: options.cwd,
    sourcemap: true,
    sourceType: 'module',
    tsconfig: true,
  })

  if (result.errors.length > 0) {
    throw new AggregateError(result.errors, 'Failed to transform Neem config')
  }

  await mkdir(configOutDir, { recursive: true })

  const mapFile = `${outputFile}.map`
  const code = result.map
    ? `${result.code}\n//# sourceMappingURL=${basename(mapFile)}\n`
    : result.code

  await writeFile(outputFile, code)
  if (result.map) {
    await writeFile(mapFile, `${JSON.stringify(result.map)}\n`)
  }

  return {
    id: 'entry',
    kind: 'module',
    owner: { type: 'config' },
    file: outputFile,
    outDir: configOutDir,
  }
}

async function loadBuildConfig(
  input: NeemBuildConfigInput | undefined,
): Promise<NeemBuildConfig | undefined> {
  if (!input) return undefined
  if (typeof input === 'function') {
    return (await input()).default
  }

  return input
}

async function importDefault<T>(file: string): Promise<T> {
  return ((await import(pathToFileURL(file).href)) as EntryModule<T>).default
}

function toManifestArtifact(
  manifestDir: string,
  artifact: NeemResolvedArtifact,
): NeemBuildManifestArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    owner: artifact.owner,
    file: toManifestPath(manifestDir, artifact.file),
    outDir: toManifestPath(manifestDir, artifact.outDir),
  }
}

function toManifestPath(fromDir: string, target: string): string {
  return relative(fromDir, target).replace(/\\/g, '/')
}
