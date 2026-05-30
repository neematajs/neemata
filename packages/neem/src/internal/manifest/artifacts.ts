import type {
  NeemArtifactOwner,
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'

export type ScopedArtifactRegistry = NeemArtifactRegistry & {
  resolveFor: (
    owner: NeemArtifactOwner,
    id: string,
  ) => NeemResolvedArtifact | undefined
  scope: (owner: NeemArtifactOwner) => NeemArtifactRegistry
}

export function createArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): ScopedArtifactRegistry {
  const byOwner = new Map<string, Map<string, NeemResolvedArtifact>>()
  const byId = new Map<string, NeemResolvedArtifact>()

  for (const artifact of artifacts) {
    const ownerKey = getOwnerKey(artifact.owner)
    let ownerArtifacts = byOwner.get(ownerKey)
    if (!ownerArtifacts) {
      ownerArtifacts = new Map()
      byOwner.set(ownerKey, ownerArtifacts)
    }

    ownerArtifacts.set(artifact.id, artifact)
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
  }

  const registry: ScopedArtifactRegistry = {
    resolve(id) {
      return byId.get(id)
    },
    resolveFor(owner, id) {
      return byOwner.get(getOwnerKey(owner))?.get(id)
    },
    list() {
      return artifacts
    },
    scope(owner) {
      return {
        resolve(id) {
          return registry.resolveFor(owner, id)
        },
        list() {
          return artifacts.filter(
            (artifact) => getOwnerKey(artifact.owner) === getOwnerKey(owner),
          )
        },
      }
    },
  }

  return registry
}

function getOwnerKey(owner: NeemArtifactOwner): string {
  return owner.type === 'config' ? 'config' : `runtime:${owner.name}`
}
