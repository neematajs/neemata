import type {
  RevisionBinding,
  RevisionManifest,
  StoredGraph,
} from '../../inspector/graph.ts'
import type {
  RunKind,
  RunnableRef,
  RunnableRevision,
} from '../../types/index.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { canonicalJson } from '../../inspector/graph.ts'
import {
  graphConflict,
  manifestJson,
  missingGraph,
  refKey,
  revisionConflict,
  runRevisionConflict,
  type PreparedGraph,
  type PreparedRevision,
  type PreparedRunDefinition,
} from '../../runtime/definition.ts'
import { many, one } from './sql.ts'

// `structure` and `bindings` are text columns holding canonical JSON, so what
// is compared is the bytes that were hashed: no jsonb key reordering and no
// caller-supplied jsonb parser sits between a saved definition and its check.
type GraphRow = {
  readonly graph_hash: string
  readonly structure: string
}

type RevisionRow = {
  readonly kind: RunKind
  readonly name: string
  readonly revision: string
  readonly graph_hash: string
  readonly bindings: string
}

/** What a bundle holds that is not saved yet, in the bundle's order. */
export type MissingDefinitions = {
  readonly graphs: readonly PreparedGraph[]
  readonly revisions: readonly PreparedRevision[]
}

function mapRevision(row: RevisionRow): RevisionManifest {
  const { kind, name, revision, graph_hash: graphHash } = row
  const bindings = JSON.parse(row.bindings) as RevisionBinding[]

  return { kind, name, revision, graphHash, bindings }
}

/** Canonical structure text by graph hash. */
async function loadGraphs(
  db: WorkflowPostgresConnection,
  hashes: readonly string[],
) {
  const saved = new Map<string, string>()
  if (hashes.length === 0) return saved

  const rows = await many<GraphRow>(
    db,
    `
      SELECT graph_hash, structure
      FROM workflow_graphs
      WHERE graph_hash = ANY($1::text[])
    `,
    [hashes],
  )
  for (const row of rows) saved.set(row.graph_hash, row.structure)
  return saved
}

/** Saved manifests by `refKey`. */
async function loadRevisions(
  db: WorkflowPostgresConnection,
  refs: readonly RunnableRevision[],
) {
  const saved = new Map<string, RevisionManifest>()
  if (refs.length === 0) return saved

  const rows = await many<RevisionRow>(
    db,
    `
      SELECT r.kind, r.name, r.revision, r.graph_hash, r.bindings
      FROM workflow_revisions r
      JOIN unnest($1::text[], $2::text[], $3::text[])
        AS wanted(kind, name, revision)
        ON r.kind = wanted.kind::workflow_run_kind
       AND r.name = wanted.name
       AND r.revision = wanted.revision
    `,
    [
      refs.map((ref) => ref.kind),
      refs.map((ref) => ref.name),
      refs.map((ref) => ref.revision),
    ],
  )
  for (const row of rows) {
    const manifest = mapRevision(row)
    saved.set(refKey(manifest), manifest)
  }
  return saved
}

/**
 * Throws when the run's definitions cannot be saved as given, and returns the
 * ones still to save. Read-only, so a refused or replayed run writes nothing.
 */
export async function assertDefinitions(
  db: WorkflowPostgresConnection,
  runnable: Pick<RunnableRef, 'kind' | 'name'>,
  definition: PreparedRunDefinition,
): Promise<MissingDefinitions> {
  const { bundle, graphHash, executionRevision: revision } = definition
  const ref = revision === undefined ? undefined : { ...runnable, revision }

  const hashes = new Set(bundle.graphs.map((graph) => graph.graphHash))
  if (graphHash !== undefined) hashes.add(graphHash)
  const refs: RunnableRevision[] = [...bundle.revisions]
  if (ref) refs.push(ref)

  const savedGraphs = await loadGraphs(db, Array.from(hashes))
  const savedRevisions = await loadRevisions(db, refs)

  const graphs: PreparedGraph[] = []
  for (const graph of bundle.graphs) {
    const saved = savedGraphs.get(graph.graphHash)
    if (saved === undefined) graphs.push(graph)
    else if (saved !== graph.json) throw graphConflict(graph.graphHash)
  }
  const revisions: PreparedRevision[] = []
  for (const manifest of bundle.revisions) {
    const saved = savedRevisions.get(manifest.key)
    if (saved === undefined) revisions.push(manifest)
    else if (manifestJson(saved) !== manifest.json) {
      throw revisionConflict(manifest)
    }
  }
  const missing = { graphs, revisions }
  if (graphHash === undefined) return missing

  const provided = bundle.graphs.some((graph) => graph.graphHash === graphHash)
  if (!provided && !savedGraphs.has(graphHash)) throw missingGraph(graphHash)
  if (!ref) return missing

  const key = refKey(ref)
  const manifest =
    bundle.revisions.find((provided) => provided.key === key) ??
    savedRevisions.get(key)
  const conflict = runRevisionConflict(ref, graphHash, manifest)
  if (conflict) throw conflict
  return missing
}

// `manifestJson` is what a revision is compared by, so the stored bindings are
// the ones it normalized rather than whatever extra fields the caller passed.
function bindingsJson(manifest: PreparedRevision) {
  const { bindings } = JSON.parse(manifest.json) as { bindings: unknown }
  return canonicalJson(bindings)
}

/**
 * Saves definitions `assertDefinitions` reported missing. Must run in the
 * transaction that creates what refers to them. Rows are written one at a
 * time in the order given, which callers keep sorted, so concurrent writers
 * take their locks in one order.
 *
 * An insert that finds the row already there lost a race since the preflight:
 * it never overwrites, and compares what won instead. `DO NOTHING` waits for a
 * concurrent writer of the same key to commit, and the read that follows runs
 * on a fresh snapshot under READ COMMITTED, so it sees the winner's row.
 */
export async function saveDefinitions(
  db: WorkflowPostgresConnection,
  { graphs, revisions }: MissingDefinitions,
) {
  for (const graph of graphs) {
    const inserted = await one(
      db,
      `
        INSERT INTO workflow_graphs (graph_hash, structure)
        VALUES ($1, $2)
        ON CONFLICT (graph_hash) DO NOTHING
        RETURNING graph_hash
      `,
      [graph.graphHash, graph.json],
    )
    if (inserted) continue

    const saved = await loadGraphs(db, [graph.graphHash])
    if (saved.get(graph.graphHash) !== graph.json) {
      throw graphConflict(graph.graphHash)
    }
  }

  for (const manifest of revisions) {
    const { kind, name, revision, graphHash } = manifest
    const inserted = await one(
      db,
      `
        INSERT INTO workflow_revisions (
          kind, name, revision, graph_hash, bindings
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (kind, name, revision) DO NOTHING
        RETURNING revision
      `,
      [kind, name, revision, graphHash, bindingsJson(manifest)],
    )
    if (inserted) continue

    const saved = (await loadRevisions(db, [manifest])).get(manifest.key)
    if (!saved || manifestJson(saved) !== manifest.json) {
      throw revisionConflict(manifest)
    }
  }
}

export async function loadGraph(
  db: WorkflowPostgresConnection,
  graphHash: string,
): Promise<StoredGraph | undefined> {
  const saved = await loadGraphs(db, [graphHash])
  const json = saved.get(graphHash)
  if (json === undefined) return undefined

  return { graphHash, structure: JSON.parse(json) as StoredGraph['structure'] }
}

export async function loadRevision(
  db: WorkflowPostgresConnection,
  ref: RunnableRevision,
): Promise<RevisionManifest | undefined> {
  const saved = await loadRevisions(db, [ref])
  return saved.get(refKey(ref))
}
