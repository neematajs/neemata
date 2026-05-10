import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemBuildConfig,
  NeemBuildConfigInput,
  NeemConfig,
} from '../../public/config.ts'
import type { NeemPlugin } from '../../public/plugin.ts'
import type {
  NeemConfigDiscovery,
  NeemDiscoveredImport,
} from '../build/discovery.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../build/manifest.ts'
import { discoverConfigEntriesSync } from '../build/discovery.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'
import { buildArtifact } from '../build/rolldown.ts'
import { importDefault } from '../runtime/utils.ts'

export type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../build/manifest.ts'
export {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'

export type NeemBuildOptions = {
  config?: string
  outDir?: string
  cwd?: string
}

export type NeemBuildResult = {
  configFile: string
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
}

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

  const configArtifact = await buildConfigArtifact({
    configFile,
    discovery,
    outDir,
  })

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

  const manifestFile = await writeManifest(outDir, manifest)

  return { configFile, outDir, manifestFile, manifest }
}

export async function cleanNeemOutDir(outDir: string): Promise<void> {
  await Promise.all([
    rm(resolve(outDir, 'config'), { recursive: true, force: true }),
    rm(resolve(outDir, 'apps'), { recursive: true, force: true }),
    rm(resolve(outDir, 'plugins'), { recursive: true, force: true }),
    rm(resolve(outDir, NEEM_MANIFEST_FILE), { force: true }),
  ])
}

export async function buildConfigArtifact(options: {
  configFile: string
  discovery: NeemConfigDiscovery
  outDir: string
}): Promise<NeemResolvedArtifact> {
  return buildArtifact({
    artifact: { id: 'entry', kind: 'module', entry: options.configFile },
    owner: { type: 'config' },
    rolldown: createConfigRolldownOptions(options.discovery),
    outDir: options.outDir,
  })
}

export function createConfigRolldownOptions(
  discovery: NeemConfigDiscovery | (() => NeemConfigDiscovery),
): NeemBuildConfig {
  const imports =
    typeof discovery === 'function'
      ? () => collectDiscoveredLazyImports(discovery())
      : constantImports(collectDiscoveredLazyImports(discovery))
  return {
    external(id: string) {
      return imports().has(id)
    },
  }
}

export async function loadBuildConfig(
  input: NeemBuildConfigInput | undefined,
): Promise<NeemBuildConfig | undefined> {
  if (!input) return undefined
  if (typeof input === 'function') {
    return (await input()).default
  }

  return input
}

export function toManifestArtifact(
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

export async function writeManifest(
  outDir: string,
  manifest: NeemBuildManifest,
): Promise<string> {
  await mkdir(outDir, { recursive: true })
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  await writeFile(
    `${manifestFile}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await rename(`${manifestFile}.tmp`, manifestFile)
  return manifestFile
}

export function toManifestPath(fromDir: string, target: string): string {
  return relative(fromDir, target).replace(/\\/g, '/')
}

function collectDiscoveredLazyImports(
  discovery: NeemConfigDiscovery,
): Set<string> {
  const imports = new Set<string>()
  const add = (entry: NeemDiscoveredImport | undefined) => {
    if (!entry) return
    imports.add(entry.specifier)
    imports.add(entry.resolved)
  }

  for (const app of Object.values(discovery.apps)) {
    add(app.entry)
    add(app.build)
  }
  for (const plugin of discovery.plugins) {
    add(plugin.entry)
    add(plugin.build)
  }

  return imports
}

function constantImports(imports: Set<string>): () => Set<string> {
  return () => imports
}
