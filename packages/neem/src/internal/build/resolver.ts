import { dirname, resolve } from 'node:path'

import { ResolverFactory } from 'oxc-resolver'

import type { NeemArtifactEntry } from '../../shared/types.ts'

const resolver = new ResolverFactory({
  conditionNames: ['import', 'module', 'node', 'default'],
  extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.node'],
  tsconfig: 'auto',
})

export function resolveImportFile(importer: string, specifier: string): string {
  const result = resolver.resolveFileSync(importer, specifier)
  if (result.path) return result.path

  throw new Error(
    `Failed to resolve import [${specifier}] from [${importer}]: ${result.error ?? 'unknown resolver error'}`,
  )
}

export function resolveBuildEntry(
  importer: string,
  entry: NeemArtifactEntry | undefined,
): NeemArtifactEntry | undefined {
  if (!entry) return undefined
  if (entry instanceof URL) return assertFileUrlEntry(entry)
  if (entry.startsWith('/')) return entry
  if (entry.startsWith('.')) return resolve(dirname(importer), entry)
  return resolveImportFile(importer, entry)
}

export function resolveRequiredBuildEntry(
  importer: string,
  entry: NeemArtifactEntry,
): NeemArtifactEntry {
  return resolveBuildEntry(importer, entry) ?? entry
}

function assertFileUrlEntry(entry: URL): URL {
  if (entry.protocol === 'file:') return entry
  throw new Error(
    `Unsupported Neem artifact URL [${entry.href}]: only file: URLs are supported`,
  )
}
