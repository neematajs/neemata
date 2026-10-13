import { createHash } from 'node:crypto'

import type {
  DefinitionBundle,
  DefinitionStructure,
  GraphPresentation,
  RevisionBinding,
  RevisionManifest,
  StoredGraph,
} from '../inspector/graph.ts'
import type {
  BranchCaseDefinition,
  RunnableDefinition,
  RunnableRef,
  RunnableRevision,
} from '../types/index.ts'
import type { StoredRun } from './state.ts'
import type { RunDefinitionInput, WorkflowStore } from './store.ts'
import {
  canonicalJson,
  captureGraphPresentation,
  parseStructure,
  projectStructure,
  structureSlots,
} from '../inspector/graph.ts'
import { formatRunnableRef, WorkflowDefinitionConflictError } from './errors.ts'

/** Lowercase hex SHA-256 of the structure's canonical JSON. */
export function hashStructure(structure: DefinitionStructure): string {
  return createHash('sha256')
    .update(canonicalJson(structure), 'utf8')
    .digest('hex')
}

/**
 * A map key for `(kind, name, revision)`. A JSON tuple, so no name or revision
 * can be chosen to collide with another triple the way a delimiter could.
 */
export function refKey({ kind, name, revision }: RunnableRef): string {
  return JSON.stringify([kind, name, revision ?? null])
}

/** The part of a manifest a revision is compared by. */
export function manifestJson(manifest: RevisionManifest): string {
  const { graphHash } = manifest
  const bindings = manifest.bindings.map(({ nodeName, caseKey, target }) => ({
    nodeName,
    ...(caseKey === undefined ? {} : { caseKey }),
    target: {
      kind: target.kind,
      name: target.name,
      revision: target.revision,
    },
  }))
  return canonicalJson({ graphHash, bindings })
}

export type DefinitionDescriptor = {
  readonly ref: RunnableRef
  readonly structure: DefinitionStructure
  readonly graphHash: string
  readonly presentation?: GraphPresentation
  /** Absent for unversioned definitions: nothing pins what they reference. */
  readonly manifest?: RevisionManifest
}

type Target = {
  readonly nodeName: string
  readonly caseKey?: string
  readonly target: RunnableDefinition
}

/** In node order, then case order: the order `structureSlots` reports. */
function definitionTargets(definition: RunnableDefinition): readonly Target[] {
  if (definition.kind === 'task') return []

  const targets: Target[] = []
  for (const node of definition.nodes) {
    const { name: nodeName } = node
    switch (node.kind) {
      case 'task':
      case 'mapTask':
        targets.push({ nodeName, target: node.task })
        break
      case 'workflow':
      case 'mapWorkflow':
        targets.push({ nodeName, target: node.workflow })
        break
      case 'branch':
      case 'parallel':
        for (const caseKey in node.cases) {
          const member = node.cases[caseKey]
          if (member.kind === 'activity') continue
          const { target } = member as BranchCaseDefinition<'task' | 'workflow'>
          targets.push({ nodeName, caseKey, target })
        }
        break
      case 'activity':
        break
    }
  }
  return targets
}

function describe(definition: RunnableDefinition): DefinitionDescriptor {
  const { kind, name, revision } = definition
  const structure = projectStructure(definition)
  const graphHash = hashStructure(structure)
  const presentation = captureGraphPresentation(definition)
  const base = {
    structure,
    graphHash,
    ...(presentation === undefined ? {} : { presentation }),
  }
  if (revision === undefined) return { ref: { kind, name }, ...base }

  const ref = { kind, name, revision }
  const bindings = definitionTargets(definition).map(
    ({ nodeName, caseKey, target }): RevisionBinding => {
      if (target.revision === undefined) {
        throw new WorkflowDefinitionConflictError(
          `Versioned ${formatRunnableRef(ref)} references unversioned ${formatRunnableRef(target)} at node [${nodeName}]`,
        )
      }
      return {
        nodeName,
        ...(caseKey === undefined ? {} : { caseKey }),
        target: {
          kind: target.kind,
          name: target.name,
          revision: target.revision,
        },
      }
    },
  )
  return { ref, ...base, manifest: { ...ref, graphHash, bindings } }
}

// Derived purely from the definition object, so it is safe to keep only while
// that object cannot change: definitions built by the contract are frozen.
const described = new WeakMap<RunnableDefinition, DefinitionDescriptor>()

export function describeDefinition(
  definition: RunnableDefinition,
): DefinitionDescriptor {
  const known = described.get(definition)
  if (known) return known

  const descriptor = describe(definition)
  if (Object.isFrozen(definition)) described.set(definition, descriptor)
  return descriptor
}

/**
 * Everything a run of `root` can reach. A versioned root yields its whole
 * closure, including alternatives a run may never take, so those stay
 * inspectable after their code is gone. An unversioned root yields its own
 * graph only: nothing pins its targets, and each child saves its own graph
 * when it is created.
 */
export function collectBundle(root: RunnableDefinition): DefinitionBundle {
  const { structure, graphHash, manifest } = describeDefinition(root)
  if (manifest === undefined) {
    return { graphs: [{ graphHash, structure }], revisions: [] }
  }

  const graphs = new Map<string, StoredGraph>()
  const revisions = new Map<string, RevisionManifest>()
  // An explicit worklist over visited objects: references between revisions
  // live in manifests, so the walk terminates whatever the definitions form.
  const visited = new Set<RunnableDefinition>()
  const pending: RunnableDefinition[] = [root]

  for (let definition = pending.pop(); definition; definition = pending.pop()) {
    if (visited.has(definition)) continue
    visited.add(definition)

    const { structure, graphHash, manifest } = describeDefinition(definition)
    // `describe` already refused a versioned definition with such a target.
    if (manifest === undefined) continue

    const key = refKey(manifest)
    const known = revisions.get(key)
    if (known && manifestJson(known) !== manifestJson(manifest)) {
      throw new WorkflowDefinitionConflictError(
        `Two definitions of ${formatRunnableRef(manifest)} with different graphs or child revisions are reachable from ${formatRunnableRef(root)}`,
      )
    }
    graphs.set(graphHash, { graphHash, structure })
    revisions.set(key, manifest)
    for (const { target } of definitionTargets(definition)) pending.push(target)
  }

  return {
    graphs: Array.from(graphs.values()),
    revisions: Array.from(revisions.values()),
  }
}

function runIdentity(definition: RunnableDefinition): RunDefinitionInput {
  const { ref, graphHash, presentation } = describeDefinition(definition)
  return {
    ...(ref.revision === undefined ? {} : { executionRevision: ref.revision }),
    graphHash,
    ...(presentation === undefined ? {} : { graphPresentation: presentation }),
  }
}

/** The definition fields of a root run created from `definition`. */
export function runDefinitionInput(
  definition: RunnableDefinition,
): RunDefinitionInput {
  return { ...runIdentity(definition), definitions: collectBundle(definition) }
}

/**
 * The definition fields of a child run of `parent` created from `target`. A
 * versioned parent saved its whole closure when it was created, so its child
 * only names what is saved already, and the store verifies that it is. An
 * unversioned parent saved nothing about its targets, so the child brings its
 * own.
 */
export function childRunDefinitionInput(
  parent: Pick<StoredRun, 'executionRevision'>,
  target: RunnableDefinition,
): RunDefinitionInput {
  return parent.executionRevision === undefined
    ? runDefinitionInput(target)
    : runIdentity(target)
}

export type PreparedGraph = StoredGraph & {
  /** Canonical JSON of the structure: what a stored graph is compared by. */
  readonly json: string
}

export type PreparedRevision = RevisionManifest & {
  readonly key: string
  /** See `manifestJson`. */
  readonly json: string
}

export type PreparedBundle = {
  /** Ordered by hash, so concurrent writers take locks in one order. */
  readonly graphs: readonly PreparedGraph[]
  /** Ordered by key, for the same reason. */
  readonly revisions: readonly PreparedRevision[]
}

const hashPattern = /^[0-9a-f]{64}$/

function compareText(left: string, right: string) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function assertRevisionRef(ref: RunnableRef): asserts ref is RunnableRevision {
  const { kind, name, revision } = ref
  if (
    (kind !== 'workflow' && kind !== 'task') ||
    typeof name !== 'string' ||
    name === '' ||
    typeof revision !== 'string' ||
    revision === ''
  ) {
    throw new WorkflowDefinitionConflictError(
      'A revision manifest needs a kind, a name and a non-empty revision',
    )
  }
}

/**
 * The adapters' boundary check, run before any write. It trusts nothing in the
 * bundle: every graph must hash to its key, every manifest must bind exactly
 * the targets its graph declares, and every bound revision must be in the same
 * bundle, so saving a bundle can never leave a dangling reference.
 */
export function prepareBundle(bundle: DefinitionBundle): PreparedBundle {
  const graphs = new Map<string, PreparedGraph>()
  for (const { graphHash, structure: raw } of bundle.graphs) {
    const structure = parseStructure(raw)
    const json = canonicalJson(structure)
    if (hashStructure(structure) !== graphHash) {
      throw new WorkflowDefinitionConflictError(
        `Graph [${graphHash}] does not hash to its key`,
      )
    }
    graphs.set(graphHash, { graphHash, structure, json })
  }

  const revisions = new Map<string, PreparedRevision>()
  for (const manifest of bundle.revisions) {
    assertRevisionRef(manifest)
    const { kind, name, revision, graphHash } = manifest
    const label = formatRunnableRef(manifest)
    const graph = graphs.get(graphHash)
    if (!graph) {
      throw new WorkflowDefinitionConflictError(
        `Bundle lacks graph [${graphHash}] of ${label}`,
      )
    }
    if (graph.structure.kind !== kind || graph.structure.name !== name) {
      throw new WorkflowDefinitionConflictError(
        `Graph [${graphHash}] does not describe ${label}`,
      )
    }

    const slots = structureSlots(graph.structure)
    const bound =
      slots.length === manifest.bindings.length &&
      slots.every((slot, index) => {
        const { nodeName, caseKey, target } = manifest.bindings[index]!
        return (
          slot.nodeName === nodeName &&
          slot.caseKey === caseKey &&
          slot.target.kind === target.kind &&
          slot.target.name === target.name
        )
      })
    if (!bound) {
      throw new WorkflowDefinitionConflictError(
        `Bindings of ${label} do not match the targets of its graph`,
      )
    }
    for (const { target } of manifest.bindings) assertRevisionRef(target)

    const key = refKey(manifest)
    const json = manifestJson(manifest)
    const known = revisions.get(key)
    if (known && known.json !== json) {
      throw new WorkflowDefinitionConflictError(
        `Bundle holds two different manifests of ${label}`,
      )
    }
    const { bindings } = manifest
    revisions.set(key, { kind, name, revision, graphHash, bindings, key, json })
  }

  for (const manifest of revisions.values()) {
    for (const { target } of manifest.bindings) {
      if (revisions.has(refKey(target))) continue
      throw new WorkflowDefinitionConflictError(
        `Bundle lacks ${formatRunnableRef(target)} bound by ${formatRunnableRef(manifest)}`,
      )
    }
  }

  return {
    graphs: Array.from(graphs.values()).sort((left, right) =>
      compareText(left.graphHash, right.graphHash),
    ),
    revisions: Array.from(revisions.values()).sort((left, right) =>
      compareText(left.key, right.key),
    ),
  }
}

export type PreparedRunDefinition = {
  readonly executionRevision?: string
  readonly graphHash?: string
  readonly graphPresentation?: GraphPresentation
  readonly bundle: PreparedBundle
}

const emptyBundle: DefinitionBundle = { graphs: [], revisions: [] }

/** Validates the definition fields of a run before an adapter writes anything. */
export function prepareRunDefinition(
  input: RunDefinitionInput,
): PreparedRunDefinition {
  const { executionRevision, graphHash, graphPresentation } = input
  if (executionRevision !== undefined) {
    if (typeof executionRevision !== 'string' || executionRevision === '') {
      throw new WorkflowDefinitionConflictError(
        'A run revision must be a non-empty string',
      )
    }
    if (graphHash === undefined) {
      throw new WorkflowDefinitionConflictError(
        `A run pinned to revision [${executionRevision}] needs a graph hash`,
      )
    }
  }
  if (graphHash !== undefined && !hashPattern.test(graphHash)) {
    throw new WorkflowDefinitionConflictError(
      `Invalid graph hash [${graphHash}]`,
    )
  }

  return {
    ...(executionRevision === undefined ? {} : { executionRevision }),
    ...(graphHash === undefined ? {} : { graphHash }),
    ...(graphPresentation === undefined ? {} : { graphPresentation }),
    bundle: prepareBundle(input.definitions ?? emptyBundle),
  }
}

export function graphConflict(
  graphHash: string,
  detail = 'is already saved with different content',
) {
  return new WorkflowDefinitionConflictError(`Graph [${graphHash}] ${detail}`)
}

export function revisionConflict(ref: RunnableRevision) {
  return new WorkflowDefinitionConflictError(
    `${formatRunnableRef(ref)} is already saved with a different graph or different child revisions; a changed definition needs a new revision`,
  )
}

export function missingGraph(graphHash: string) {
  return new WorkflowDefinitionConflictError(
    `Graph [${graphHash}] is not saved and was not provided`,
  )
}

/**
 * The run a `join` found under its unique key, when it must not be joined. Two
 * unversioned runs join as they always did, whatever they are. Once either
 * side is versioned the kind, name and revision must all match: the caller
 * would otherwise receive a run typed by a contract it was not created with.
 */
export function refusedJoinHolder(
  existing: Pick<StoredRun, 'kind' | 'name' | 'executionRevision'>,
  requested: Pick<StoredRun, 'kind' | 'name' | 'executionRevision'>,
): RunnableRef | undefined {
  const { kind, name, executionRevision: revision } = existing
  if (revision === undefined && requested.executionRevision === undefined) {
    return undefined
  }
  if (
    kind === requested.kind &&
    name === requested.name &&
    revision === requested.executionRevision
  ) {
    return undefined
  }
  return { kind, name, ...(revision === undefined ? {} : { revision }) }
}

/** The saved manifest of a run's revision must exist and carry the run's graph. */
export function runRevisionConflict(
  ref: RunnableRevision,
  graphHash: string,
  stored: Pick<RevisionManifest, 'graphHash'> | undefined,
): WorkflowDefinitionConflictError | undefined {
  if (stored === undefined) {
    return new WorkflowDefinitionConflictError(
      `${formatRunnableRef(ref)} is not saved and was not provided`,
    )
  }
  if (stored.graphHash === graphHash) return undefined
  return new WorkflowDefinitionConflictError(
    `${formatRunnableRef(ref)} is saved with graph [${stored.graphHash}], not [${graphHash}]`,
  )
}

/**
 * Whether the code a worker registered for a run's revision is the code the
 * run was created against. Checked against the durable manifest on every
 * delivery: a worker that never started a run would otherwise execute a
 * revision whose graph or child bindings were edited in place. Unversioned
 * runs are not checked; their name alone selects the code, as it always did.
 */
export async function findDefinitionConflict(
  store: Pick<WorkflowStore, 'loadRevision'>,
  run: Pick<
    StoredRun,
    'id' | 'kind' | 'name' | 'executionRevision' | 'graphHash'
  >,
  definition: RunnableDefinition,
): Promise<WorkflowDefinitionConflictError | undefined> {
  const { kind, name, executionRevision: revision } = run
  if (revision === undefined) return undefined

  const ref = { kind, name, revision }
  const label = formatRunnableRef(ref)
  const local = describeDefinition(definition)
  if (local.manifest === undefined || local.graphHash !== run.graphHash) {
    return new WorkflowDefinitionConflictError(
      `Registered ${label} does not have the graph run [${run.id}] was created with; a changed definition needs a new revision`,
    )
  }

  const stored = await store.loadRevision(ref)
  if (stored === undefined) {
    return new WorkflowDefinitionConflictError(
      `Run [${run.id}] is pinned to ${label}, which has no saved manifest`,
    )
  }
  if (manifestJson(stored) === manifestJson(local.manifest)) return undefined
  return new WorkflowDefinitionConflictError(
    `Registered ${label} binds different child revisions than its saved manifest; a changed definition needs a new revision`,
  )
}
