import type {
  NeemArtifactOwner,
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '#public/artifact.ts'

export type NeemScopedArtifactRegistry = NeemArtifactRegistry & {
  resolveFor: (
    owner: NeemArtifactOwner,
    id: string,
  ) => NeemResolvedArtifact | undefined
  scope: (owner: NeemArtifactOwner) => NeemArtifactRegistry
}

export function createNeemArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): NeemScopedArtifactRegistry {
  const byOwner = new Map<string, Map<string, NeemResolvedArtifact[]>>()
  const byId = new Map<string, NeemResolvedArtifact[]>()

  for (const artifact of artifacts) {
    const ownerKey = getOwnerKey(artifact.owner)
    let ownerArtifacts = byOwner.get(ownerKey)
    if (!ownerArtifacts) {
      ownerArtifacts = new Map()
      byOwner.set(ownerKey, ownerArtifacts)
    }

    pushArtifact(ownerArtifacts, artifact.id, artifact)
    pushArtifact(byId, artifact.id, artifact)
  }

  const registry: NeemScopedArtifactRegistry = Object.freeze({
    resolve(id: string) {
      return byId.get(id)?.[0]
    },
    resolveFor(owner: NeemArtifactOwner, id: string) {
      return byOwner.get(getOwnerKey(owner))?.get(id)?.[0] ?? byId.get(id)?.[0]
    },
    list() {
      return artifacts
    },
    scope(owner: NeemArtifactOwner) {
      return Object.freeze({
        resolve(id: string) {
          return registry.resolveFor(owner, id)
        },
        list() {
          return artifacts
        },
      })
    },
  })

  return registry
}

function pushArtifact(
  map: Map<string, NeemResolvedArtifact[]>,
  id: string,
  artifact: NeemResolvedArtifact,
) {
  const artifacts = map.get(id)
  if (artifacts) {
    artifacts.push(artifact)
    return
  }

  map.set(id, [artifact])
}

function getOwnerKey(owner: NeemArtifactOwner): string {
  if (owner.type === 'config') return 'config'
  if (owner.type === 'app') return `app:${owner.name}`
  return `plugin:${owner.instanceId}:${owner.name}`
}
