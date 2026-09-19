import type {
  NeemArtifactOwner,
  NeemResolvedArtifact,
} from '../../shared/types.ts'

export type ScopedArtifactRegistry = {
  resolveFor: (
    owner: NeemArtifactOwner,
    id: string,
  ) => NeemResolvedArtifact | undefined
  list: () => readonly NeemResolvedArtifact[]
}

export function createArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): ScopedArtifactRegistry {
  const byOwner = new Map<string, Map<string, NeemResolvedArtifact>>()

  for (const artifact of artifacts) {
    const ownerKey = getOwnerKey(artifact.owner)
    let ownerArtifacts = byOwner.get(ownerKey)
    if (!ownerArtifacts) {
      ownerArtifacts = new Map()
      byOwner.set(ownerKey, ownerArtifacts)
    }

    ownerArtifacts.set(artifact.id, artifact)
  }

  return {
    resolveFor(owner, id) {
      return byOwner.get(getOwnerKey(owner))?.get(id)
    },
    list() {
      return artifacts
    },
  }
}

function getOwnerKey(owner: NeemArtifactOwner): string {
  return owner.type === 'config' ? 'config' : `runtime:${owner.name}`
}
