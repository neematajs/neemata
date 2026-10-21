import type { Runnable } from '../errors.ts'
import type { DefinitionRecord, StoredRun } from '../model.ts'
import type { Described } from '../program.ts'
import type { Draft } from './draft.ts'
import { DefinitionConflict } from '../errors.ts'
import { canonical } from './keys.ts'

const GRAPH = 'graph:'
const REVISION = 'revision:'

type Revision = Required<Runnable>

export const graphKey = (graphHash: string) => `${GRAPH}${graphHash}`

/** Whether a saved graph is a durable workflow's: one with a body, no steps. */
export const durableGraph = (graph: unknown): boolean =>
  typeof graph === 'object' &&
  graph !== null &&
  (graph as { readonly mode?: unknown }).mode === 'durable'

/**
 * A JSON tuple, so no name or revision can be chosen to collide with another
 * triple the way a delimiter could.
 */
export const revisionKey = ({ kind, name, revision }: Revision) =>
  `${REVISION}${JSON.stringify([kind, name, revision])}`

/** `workflow [name@revision]`, or `workflow [name]` for the unversioned lane. */
export const label = ({ kind, name, revision }: Runnable) =>
  revision === undefined ? `${kind} [${name}]` : `${kind} [${name}@${revision}]`

/** What a record's key names, for a message. */
export function named(key: string) {
  if (key.startsWith(GRAPH)) return `graph [${key.slice(GRAPH.length)}]`
  const [kind, name, revision] = JSON.parse(key.slice(REVISION.length))
  return label({ kind, name, revision })
}

function saved(key: string) {
  return new DefinitionConflict({
    message: key.startsWith(GRAPH)
      ? `${named(key)} is already saved with different content`
      : `${named(key)} is already saved with a different graph or different child revisions; a changed definition needs a new revision`,
  })
}

/**
 * Why records cannot be saved as given, if they cannot: a key of theirs holds
 * other content. Reads only, so a plan checks before it writes anything.
 */
export function conflicting(
  draft: Draft,
  records: readonly DefinitionRecord[],
): DefinitionConflict | undefined {
  draft.require({ definitions: records.map(({ key }) => key) })
  const conflict = records.find(({ key, value }) => {
    const held = draft.definition(key)
    return held !== undefined && canonical(held) !== canonical(value)
  })
  return conflict && saved(conflict.key)
}

/** Saves the records that are not saved yet; `conflicting` found no other. */
export function save(draft: Draft, records: readonly DefinitionRecord[]) {
  for (const record of records) {
    if (draft.definition(record.key) === undefined) draft.save(record)
  }
}

/** What a run created from a described program records of it. */
export function described(
  definition: Described | undefined,
): Pick<StoredRun, 'graphHash' | 'presentation'> {
  if (!definition) return {}
  const { graphHash, presentation } = definition
  return { graphHash, ...(presentation === undefined ? {} : { presentation }) }
}

/**
 * Why the program a worker registered for a run's revision is not the code
 * the run was created against, if it is not. Checked against what is saved on
 * every delivery: a worker that never started a run would otherwise run a
 * revision whose graph or child bindings were edited in place. Unversioned
 * runs are not checked: their name alone selects the code.
 */
export function drift(
  draft: Draft,
  run: StoredRun,
  definition: Described | undefined,
): DefinitionConflict | undefined {
  const { id, kind, name, revision } = run
  if (revision === undefined) return undefined

  const registered = `Registered ${label({ kind, name, revision })}`
  const changed = 'a changed definition needs a new revision'
  if (definition?.graphHash !== run.graphHash) {
    return new DefinitionConflict({
      message: `${registered} does not have the graph run [${id}] was created with; ${changed}`,
    })
  }
  // Neither side is described: a program written by hand runs unchecked.
  if (!definition) return undefined

  const key = revisionKey({ kind, name, revision })
  const held = draft.definition(key)
  if (held === undefined) {
    return new DefinitionConflict({
      message: `Run [${id}] is pinned to ${label({ kind, name, revision })}, which has no saved manifest`,
    })
  }
  const own = definition.records.find((record) => record.key === key)
  if (own && canonical(own.value) === canonical(held)) return undefined
  return new DefinitionConflict({
    message: `${registered} binds different child revisions than its saved manifest; ${changed}`,
  })
}
