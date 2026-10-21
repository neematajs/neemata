import { createHash } from 'node:crypto'

import type { DefinitionRecord, RunKind } from '../model.ts'
import type { Described } from '../program.ts'
import type {
  Definition,
  DefinitionStructure,
  GraphPresentation,
} from './structure.ts'
import { stepTargets } from '../dsl/plan.ts'
import { DefinitionConflict } from '../errors.ts'
import { graphKey, label, named, revisionKey } from '../plan/definitions.ts'
import { canonical } from '../plan/keys.ts'
import {
  canonicalJson,
  captureGraphPresentation,
  projectStructure,
  USES,
} from './structure.ts'

/** Lowercase hex SHA-256 of the structure's canonical JSON. */
export function hashStructure(structure: DefinitionStructure): string {
  return createHash('sha256')
    .update(canonicalJson(structure), 'utf8')
    .digest('hex')
}

export type RunnableRevision = {
  readonly kind: RunKind
  readonly name: string
  readonly revision: string
}

/** The exact revision one named target slot of a workflow runs. */
export type RevisionBinding = {
  readonly nodeName: string
  /** Set for branch cases and parallel members; absent for a node's own target. */
  readonly caseKey?: string
  readonly target: RunnableRevision
}

/**
 * Immutable record of one revision: its graph and the revision of every task
 * and child workflow it references, the cases a run may never take included.
 * A child's revision is part of its parent's manifest, not of the parent's
 * graph hash.
 */
export type RevisionManifest = RunnableRevision & {
  readonly graphHash: string
  /** In node order, then case order. Empty for tasks. */
  readonly bindings: readonly RevisionBinding[]
}

export type DefinitionDescriptor = {
  readonly structure: DefinitionStructure
  readonly graphHash: string
  readonly presentation?: GraphPresentation
  /** Absent for unversioned definitions: nothing pins what they reference. */
  readonly manifest?: RevisionManifest
}

/** What is saved about a definition: its graph, its labels, its bindings. */
export function describeDefinition(
  definition: Definition,
): DefinitionDescriptor {
  const { kind, name, revision } = definition
  const structure = projectStructure(definition)
  const graphHash = hashStructure(structure)
  const presentation = captureGraphPresentation(definition)
  const base = {
    structure,
    graphHash,
    ...(presentation === undefined ? {} : { presentation }),
  }
  if (revision === undefined) return base

  const steps = definition.kind === 'task' ? [] : definition.steps
  const uses = definition.kind === 'task' ? [] : (definition.uses ?? [])
  const used = uses.map(
    (target): RevisionBinding => ({
      nodeName: USES,
      target: {
        kind: target.kind,
        name: target.name,
        // `durable(...)` refuses a target without a revision.
        revision: target.revision!,
      },
    }),
  )
  const bindings = steps.flatMap((step) =>
    stepTargets(step).map(
      ({ caseKey, target }): RevisionBinding => ({
        nodeName: step.name,
        ...(caseKey === undefined ? {} : { caseKey }),
        target: {
          kind: target.kind,
          name: target.name,
          // `workflow(...)` refused a versioned workflow whose target is not.
          revision: target.revision!,
        },
      }),
    ),
  )
  return {
    ...base,
    manifest: {
      kind,
      name,
      revision,
      graphHash,
      bindings: [...bindings, ...used],
    },
  }
}

/** What a declaration a durable workflow uses describes itself as, if anything. */
function described(target: unknown) {
  const program = (
    target as { readonly program?: { readonly definition?: Described } }
  ).program
  return program?.definition
}

function deepFreeze<A>(value: A): A {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member)
    Object.freeze(value)
  }
  return value
}

/**
 * A declaration as the engine carries it on the declaration's program. For a
 * revision the records are its whole closure, alternatives a run may never
 * take included, so those stay inspectable after their code is gone.
 *
 * Frozen through: what a start saves must not change with anything a caller
 * still holds.
 */
export function describe(definition: Definition): Described {
  const { structure, graphHash, presentation, manifest } =
    describeDefinition(definition)
  const records = new Map<string, DefinitionRecord>()
  const add = (record: DefinitionRecord) => {
    const known = records.get(record.key)
    // Only a manifest can differ under its key: a graph's key is its hash.
    if (known && canonical(known.value) !== canonical(record.value)) {
      throw new DefinitionConflict({
        message: `Two definitions of ${named(record.key)} with different graphs or child revisions are reachable from ${label(definition)}`,
      })
    }
    records.set(record.key, record)
  }

  add({ key: graphKey(graphHash), value: structure })
  if (manifest && definition.kind === 'workflow') {
    for (const step of definition.steps) {
      for (const { target } of stepTargets(step)) {
        // A target's records are its own closure already.
        target.program.definition?.records.forEach(add)
      }
    }
    for (const target of definition.uses ?? []) {
      described(target)?.records.forEach(add)
    }
  }
  if (manifest) add({ key: revisionKey(manifest), value: manifest })

  return deepFreeze({
    graphHash,
    ...(presentation === undefined ? {} : { presentation }),
    records: Array.from(records.values()),
  })
}
