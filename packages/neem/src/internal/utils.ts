import { pathToFileURL } from 'node:url'

import type {
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '../public/artifact.ts'

type EntryModule<T> = { default: T }

export async function importDefault<T>(file: string): Promise<T> {
  const module: EntryModule<T> = await import(pathToFileURL(file).href)
  return module.default
}

export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

export function createArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): NeemArtifactRegistry {
  const byId = new Map<string, NeemResolvedArtifact>()
  for (const artifact of artifacts) {
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
  }

  return Object.freeze({
    resolve(id: string) {
      return byId.get(id)
    },
    list() {
      return artifacts
    },
  })
}
