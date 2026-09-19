import type { StoredRun } from '../../runtime/state.ts'
import type { RuntimeRunStatus } from '../../runtime/status.ts'
import type {
  CreateRunInput,
  DeleteRunResult,
  ListRunsFilter,
  PruneTerminalRunsParams,
  PruneTerminalRunsResult,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { ResolvedRunUnique } from '../../types/index.ts'
import type { JsonRecord, WorkflowPostgresConnection } from './connection.ts'
import type {
  AttemptRow,
  ChildRow,
  NodeRow,
  RunLeaseRow,
  RunRow,
  RunSummaryRow,
} from './rows.ts'
import { WorkflowRunConflictError } from '../../runtime/errors.ts'
import {
  normalizeBatchSize,
  normalizePruneStatuses,
} from '../../runtime/limits.ts'
import { isTerminalRunStatus } from '../../runtime/status.ts'
import { sameValue } from './compare.ts'
import { createDeadCommandStore } from './dead-commands.ts'
import { TERMINAL_RUN_STATUSES_SQL, statusNotify } from './fragments.ts'
import { id, isUuid, json, jsonRow, jsonRows, many, one } from './query.ts'
import {
  mapAttempt,
  mapAttemptSummary,
  mapNode,
  mapNodeChild,
  mapNodeChildSummary,
  mapNodeSummary,
  mapRun,
  mapRunLease,
  mapRunSummary,
} from './rows.ts'

type PostgresWorkflowRunStore = Pick<
  WorkflowStore,
  | 'createRun'
  | 'listRuns'
  | 'listRunSummaries'
  | 'pruneTerminalRuns'
  | 'deleteRun'
  | 'listDeadCommands'
  | 'listUnreapedDeadCommands'
  | 'markDeadCommandReaped'
  | 'requeueDeadCommand'
  | 'acquireRunLease'
  | 'renewRunLease'
  | 'releaseRunLease'
  | 'loadRunSnapshot'
  | 'loadRunDetail'
  | 'listRunFamily'
  | 'loadRuns'
>

export type InsertRunOptions = {
  /**
   * Resolve a lost insert race inline. Callers owning the enclosing
   * transaction opt out: their rollback has to happen first.
   */
  readonly inlineRaceRecovery?: boolean
}

/**
 * Adapter-internal signal: the run insert conflicted and inline recovery was
 * declined or found nothing. Callers owning the enclosing transaction catch
 * it after rollback and re-read on the base connection.
 */
export class WorkflowRunInsertConflict extends Error {
  constructor(name: string) {
    super(`Workflow run insert conflicted [${name}]`)
    this.name = 'WorkflowRunInsertConflict'
  }
}

// Run creation is the one write that needs strictly increasing timestamps:
// listing pages by (created_at, id) and cursors assume a total order.
let lastTimestamp = 0
const monotonicNow = () => {
  const current = Date.now()
  lastTimestamp = Math.max(current, lastTimestamp + 1)
  return new Date(lastTimestamp)
}

const runnableName = (input: CreateRunInput) =>
  input.name ?? input.taskName ?? input.workflowName

const loadIdempotentRun = async (
  connection: WorkflowPostgresConnection,
  input: CreateRunInput,
) => {
  if (!input.idempotencyKey) return undefined
  const existing = await one<RunRow>(
    connection,
    'SELECT * FROM workflow_runs WHERE idempotency_key = $1::jsonb',
    [json(input.idempotencyKey)],
  )
  if (!existing) return undefined

  const run = mapRun(existing)
  const matches =
    run.kind === (input.kind ?? 'workflow') &&
    run.name === runnableName(input) &&
    run.workflowName === input.workflowName &&
    run.taskName === input.taskName &&
    run.parentRunId === input.parentRunId &&
    run.parentNodeName === input.parentNodeName &&
    run.rootRunId === (input.rootRunId ?? run.id) &&
    sameValue(run.input, input.input)
  if (!matches) {
    throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
  }
  return run
}

const loadUniqueRun = async (
  connection: WorkflowPostgresConnection,
  unique: NonNullable<CreateRunInput['unique']>,
) => {
  const statusFilter =
    unique.scope === 'active'
      ? `AND status NOT IN (${TERMINAL_RUN_STATUSES_SQL})`
      : ''
  const existing = await one<RunRow>(
    connection,
    `
      SELECT * FROM workflow_runs
      WHERE unique_key = $1::jsonb AND unique_scope = $2 ${statusFilter}
    `,
    [json(unique.key), unique.scope],
  )
  return existing ? mapRun(existing) : undefined
}

export const runConflictError = (run: StoredRun, unique: ResolvedRunUnique) =>
  new WorkflowRunConflictError({
    runId: run.id,
    status: run.status,
    key: unique.key,
    scope: unique.scope,
  })

export const insertRun = async (
  connection: WorkflowPostgresConnection,
  input: CreateRunInput,
  options: InsertRunOptions = {},
): Promise<{ readonly run: StoredRun; readonly created: boolean }> => {
  const inlineRaceRecovery = options.inlineRaceRecovery ?? true
  const { unique } = input
  const resolveUniqueConflict = (
    run: StoredRun,
    holding: ResolvedRunUnique,
  ) => {
    if (holding.behavior === 'join') return { run, created: false as const }
    throw runConflictError(run, holding)
  }

  const existing = await loadIdempotentRun(connection, input)
  if (existing) return { run: existing, created: false }
  if (unique) {
    const conflicting = await loadUniqueRun(connection, unique)
    if (conflicting) return resolveUniqueConflict(conflicting, unique)
  }

  const notify = statusNotify('run_created', 'inserted')
  // ON CONFLICT DO NOTHING turns a lost race into zero rows instead of an
  // error, so the recovery reads below stay legal inside any transaction —
  // including a caller-provided one. The retry covers a holder leaving its
  // uniqueness scope between the conflict and the recovery read.
  for (let attempt = 0; attempt < 2; attempt++) {
    const date = monotonicNow()
    const runId = id()
    const row = await one<RunRow>(
      connection,
      `
      WITH inserted AS (
        INSERT INTO workflow_runs (
          id, kind, name, workflow_name, task_name, status, input,
          parent_run_id, parent_node_name, root_run_id, tags,
          idempotency_key, unique_key, unique_scope, unique_behavior,
          version, active_since, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'queued', $6::jsonb,
          $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14,
          1, $15, $15, $15
        )
        ON CONFLICT DO NOTHING
        RETURNING *, NULL::text AS old_status
      ),${notify.cte}
      SELECT inserted.*${notify.columns}
      FROM inserted
      `,
      [
        runId,
        input.kind ?? 'workflow',
        runnableName(input),
        input.workflowName,
        input.taskName ?? null,
        json(input.input),
        input.parentRunId ?? null,
        input.parentNodeName ?? null,
        input.rootRunId ?? runId,
        json(input.tags ?? {}),
        input.idempotencyKey ? json(input.idempotencyKey) : null,
        unique ? json(unique.key) : null,
        unique?.scope ?? null,
        unique?.behavior ?? null,
        date,
      ],
    )
    if (row) return { run: mapRun(row), created: true }

    if (inlineRaceRecovery && input.idempotencyKey) {
      const raced = await loadIdempotentRun(connection, input)
      if (raced) return { run: raced, created: false }
    }
    if (unique) {
      const raced = await loadUniqueRun(connection, unique)
      if (raced) return resolveUniqueConflict(raced, unique)
    }
    if (!inlineRaceRecovery) break
  }
  throw new WorkflowRunInsertConflict(runnableName(input))
}

export const pruneTerminalRunsInTransaction = async (
  connection: WorkflowPostgresConnection,
  params: PruneTerminalRunsParams,
): Promise<PruneTerminalRunsResult> => {
  const batchSize = normalizeBatchSize(params.batchSize)
  const statuses = normalizePruneStatuses(params.statuses)
  let deleted = 0

  if (batchSize > 0 && statuses.length > 0) {
    // normalizePruneStatuses keeps only known terminal literals, so the list
    // inlines as safely as the other status predicates.
    const statusList = statuses.map((status) => `'${status}'`).join(', ')
    const rows = await many<{ id: string }>(
      connection,
      `
        DELETE FROM workflow_runs
        WHERE id IN (
          SELECT r.id
          FROM workflow_runs r
          WHERE r.parent_run_id IS NULL
            AND r.status IN (${statusList})
            AND r.updated_at < $1
            AND NOT EXISTS (
              SELECT 1
              FROM workflow_runs d
              WHERE d.root_run_id = r.id
                AND d.id <> r.id
                AND d.status NOT IN (${TERMINAL_RUN_STATUSES_SQL})
            )
          ORDER BY r.updated_at, r.id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `,
      [params.olderThan, batchSize],
    )
    deleted = rows.length
  }

  await connection.query(
    `
      DELETE FROM workflow_commands
      WHERE dead_at IS NOT NULL
        AND dead_at < $1
    `,
    [params.olderThan],
  )

  return { deleted }
}

export const deleteRunInTransaction = async (
  connection: WorkflowPostgresConnection,
  runId: string,
): Promise<DeleteRunResult> => {
  if (!isUuid(runId)) return { deleted: false }

  const target = await one<RunRow>(
    connection,
    'SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE',
    [runId],
  )
  if (!target) return { deleted: false }
  if (target.parent_run_id !== null && target.parent_run_id !== undefined) {
    throw new Error(`Run [${runId}] is not a root run`)
  }

  // FOR UPDATE is not allowed on a recursive CTE, so the family is collected
  // first and locked in a second statement.
  const descendants = await many<{ id: string }>(
    connection,
    `
      WITH RECURSIVE descendants AS (
        SELECT id
        FROM workflow_runs
        WHERE id = $1
        UNION
        SELECT r.id
        FROM workflow_runs r
        JOIN descendants d
          ON (r.parent_run_id = d.id OR r.root_run_id = d.id)
         AND r.id <> d.id
      )
      SELECT id
      FROM descendants
    `,
    [runId],
  )
  const familyRunIds = descendants.map((run) => run.id)
  const family = await many<{ id: string; status: RuntimeRunStatus }>(
    connection,
    `
      SELECT id, status
      FROM workflow_runs
      WHERE id = ANY($1::uuid[])
      ORDER BY created_at, id
      FOR UPDATE
    `,
    [familyRunIds],
  )
  if (family.some((run) => !isTerminalRunStatus(run.status))) {
    throw new Error(`Run [${runId}] has non-terminal runs`)
  }

  // Guards against schema drift if workflow_commands_run_fk stops cascading.
  await connection.query(
    'DELETE FROM workflow_commands WHERE run_id = ANY($1::uuid[])',
    [familyRunIds],
  )
  const deleted = await many<{ id: string }>(
    connection,
    'DELETE FROM workflow_runs WHERE id = $1 RETURNING id',
    [runId],
  )

  return { deleted: deleted.length > 0 }
}

type RunListQuery = {
  readonly params: readonly unknown[]
  readonly whereSql: string
  readonly limitSql: string
  readonly offset: number
  readonly limit: number | null
}

const nodeCountsJoinSql = (alias: string) => `
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS nodes_total,
      (count(*) FILTER (WHERE n.status = 'completed'))::int AS nodes_completed
    FROM workflow_nodes n
    WHERE n.run_id = ${alias}.id
  ) ${alias}_node_counts ON true
`

const runSummaryColumnsSql = (alias: string) => `
  ${alias}.id,
  ${alias}.kind,
  ${alias}.name,
  ${alias}.workflow_name,
  ${alias}.task_name,
  ${alias}.status,
  ${alias}.error,
  ${alias}.parent_run_id,
  ${alias}.parent_node_name,
  ${alias}.root_run_id,
  ${alias}.tags,
  ${alias}.idempotency_key,
  ${alias}.version,
  ${alias}.active_since,
  ${alias}.created_at,
  ${alias}.updated_at,
  ${alias}_node_counts.nodes_total AS nodes_total,
  ${alias}_node_counts.nodes_completed AS nodes_completed
`

const runSummaryJsonSql = (alias: string) => `
  to_jsonb(${alias}) - 'input' - 'output' ||
  (
    SELECT jsonb_build_object(
      'nodes_total',
      count(*)::int,
      'nodes_completed',
      (count(*) FILTER (WHERE n.status = 'completed'))::int
    )
    FROM workflow_nodes n
    WHERE n.run_id = ${alias}.id
  )
`

const buildListRunsQuery = (
  filter: ListRunsFilter,
): RunListQuery | undefined => {
  if (
    filter.limit !== undefined &&
    (!Number.isFinite(filter.limit) || filter.limit < 1)
  ) {
    return undefined
  }

  const params: unknown[] = []
  const where: string[] = []
  const push = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }

  if (filter.kind !== undefined) where.push(`r.kind = ${push(filter.kind)}`)
  if (filter.name !== undefined) where.push(`r.name = ${push(filter.name)}`)
  if (filter.activeBefore !== undefined) {
    where.push(`r.active_since < ${push(filter.activeBefore)}`)
  }
  if (filter.createdBefore !== undefined) {
    where.push(`r.created_at < ${push(filter.createdBefore)}`)
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    where.push(
      `r.status IN (${statuses.map((status) => push(status)).join(', ')})`,
    )
  }
  if (filter.parentRunId !== undefined) {
    if (filter.parentRunId === null) {
      where.push('r.parent_run_id IS NULL')
    } else {
      if (!isUuid(filter.parentRunId)) return undefined
      where.push(`r.parent_run_id = ${push(filter.parentRunId)}`)
    }
  }
  if (filter.rootRunId !== undefined) {
    if (!isUuid(filter.rootRunId)) return undefined
    where.push(`r.root_run_id = ${push(filter.rootRunId)}`)
  }
  if (filter.tags !== undefined) {
    where.push(`r.tags @> ${push(json(filter.tags))}::jsonb`)
  }
  if (filter.input !== undefined) {
    where.push(`r.input @> ${push(json(filter.input))}::jsonb`)
  }

  const offset = filter.cursor ? Number.parseInt(filter.cursor, 10) : 0
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid run list cursor [${filter.cursor}]`)
  }

  // One row beyond the page tells the caller whether a next cursor exists.
  const limit = filter.limit ?? null
  const limitSql = limit === null ? '' : `LIMIT ${push(limit + 1)}`
  return {
    whereSql: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`,
    limitSql,
    offset,
    limit,
    params: [...params, offset],
  }
}

const runListPage = <Row, T>(
  query: RunListQuery,
  rows: readonly Row[],
  map: (row: Row) => T,
) => {
  const { limit, offset } = query
  const page = limit === null ? rows : rows.slice(0, limit)
  return {
    runs: page.map(map),
    ...(limit !== null && rows.length > limit
      ? { nextCursor: String(offset + limit) }
      : {}),
  }
}

export const createPostgresWorkflowRunStore = (
  db: WorkflowPostgresConnection,
): PostgresWorkflowRunStore => ({
  createRun: async (input) => (await insertRun(db, input)).run,
  async listRuns(filter: ListRunsFilter = {}) {
    const query = buildListRunsQuery(filter)
    if (!query) return { runs: [] }
    const rows = await many<RunRow>(
      db,
      `
      SELECT r.*
      FROM workflow_runs r
      ${query.whereSql}
      ORDER BY r.created_at DESC, r.id DESC
      ${query.limitSql}
      OFFSET $${query.params.length}
    `,
      query.params,
    )
    return runListPage(query, rows, mapRun)
  },
  async listRunSummaries(filter: ListRunsFilter = {}) {
    const query = buildListRunsQuery(filter)
    if (!query) return { runs: [] }
    const rows = await many<RunSummaryRow>(
      db,
      `
      SELECT ${runSummaryColumnsSql('r')}
      FROM workflow_runs r
      ${nodeCountsJoinSql('r')}
      ${query.whereSql}
      ORDER BY r.created_at DESC, r.id DESC
      ${query.limitSql}
      OFFSET $${query.params.length}
    `,
      query.params,
    )
    return runListPage(query, rows, mapRunSummary)
  },
  // Lock-free on purpose: callers driving their own sweep already serialize.
  // The runtime's retentionPruner takes an advisory lock for the shared case.
  pruneTerminalRuns: (params) =>
    db.transaction((tx) => pruneTerminalRunsInTransaction(tx, params)),
  deleteRun: (runId) =>
    db.transaction((tx) => deleteRunInTransaction(tx, runId)),
  async acquireRunLease({ runId, leaseMs }) {
    if (!isUuid(runId)) return undefined
    // Gate the upsert on the advisory lock so a competing transaction skips
    // the run instead of waiting for its uncommitted lease row.
    const lease = await one<RunLeaseRow>(
      db,
      `
      WITH lock AS MATERIALIZED (
        SELECT pg_try_advisory_xact_lock(hashtext('workflow_run_lease:' || $1::text)) AS acquired
      )
      INSERT INTO workflow_run_leases (run_id, lease_token, version, expires_at)
      SELECT r.id, $2, r.version, now() + ($3::int * interval '1 millisecond')
      FROM workflow_runs r CROSS JOIN lock
      WHERE r.id = $1::uuid AND lock.acquired
      ON CONFLICT (run_id) DO UPDATE
      SET lease_token = EXCLUDED.lease_token,
          version = EXCLUDED.version,
          expires_at = EXCLUDED.expires_at
      WHERE workflow_run_leases.expires_at <= now()
      RETURNING *
    `,
      [runId, id(), leaseMs],
    )
    return lease ? mapRunLease(lease) : undefined
  },
  async renewRunLease(lease, leaseMs) {
    if (!isUuid(lease.runId)) return undefined
    const renewed = await one<RunLeaseRow>(
      db,
      `
      UPDATE workflow_run_leases
      SET expires_at = now() + ($3::int * interval '1 millisecond')
      WHERE run_id = $1 AND lease_token = $2
      RETURNING *
    `,
      [lease.runId, lease.leaseToken, leaseMs],
    )
    return renewed ? mapRunLease(renewed) : undefined
  },
  async releaseRunLease(lease) {
    if (!isUuid(lease.runId)) return
    await db.query(
      'DELETE FROM workflow_run_leases WHERE run_id = $1 AND lease_token = $2',
      [lease.runId, lease.leaseToken],
    )
  },
  async loadRuns(runIds) {
    const unique = new Set<string>()
    for (const runId of runIds) {
      if (isUuid(runId)) unique.add(runId)
    }
    const ids = Array.from(unique)
    if (ids.length === 0) return []
    const rows = await many<RunRow>(
      db,
      'SELECT * FROM workflow_runs WHERE id = ANY($1::uuid[])',
      [ids],
    )
    // ANY() returns rows in unspecified order; reorder to keep the
    // first-occurrence contract shared with the in-memory store.
    const byId = new Map<string, StoredRun>()
    for (const row of rows) {
      const run = mapRun(row)
      byId.set(run.id, run)
    }
    const runs: StoredRun[] = []
    for (const runId of ids) {
      const run = byId.get(runId)
      if (run) runs.push(run)
    }
    return runs
  },
  async loadRunSnapshot(runId) {
    if (!isUuid(runId)) return undefined
    const snapshot = await one<
      JsonRecord & {
        run: unknown
        nodes: unknown
        children: unknown
        attempts: unknown
      }
    >(
      db,
      `
      SELECT
        (SELECT to_jsonb(r) FROM workflow_runs r WHERE r.id = $1) AS run,
        COALESCE(
          (SELECT jsonb_agg(to_jsonb(n)) FROM workflow_nodes n WHERE n.run_id = $1),
          '[]'::jsonb
        ) AS nodes,
        COALESCE(
          (
            SELECT jsonb_agg(to_jsonb(c) ORDER BY c.node_name, c.ordinal, c.child_key)
            FROM workflow_node_children c
            WHERE c.run_id = $1
          ),
          '[]'::jsonb
        ) AS children,
        COALESCE(
          (SELECT jsonb_agg(to_jsonb(a)) FROM workflow_attempts a WHERE a.run_id = $1),
          '[]'::jsonb
        ) AS attempts
    `,
      [runId],
    )
    const run = jsonRow<RunRow>(snapshot?.run)
    if (!run) return undefined

    return {
      run: mapRun(run),
      nodes: jsonRows<NodeRow>(snapshot?.nodes).map(mapNode),
      children: jsonRows<ChildRow>(snapshot?.children).map(mapNodeChild),
      attempts: jsonRows<AttemptRow>(snapshot?.attempts).map(mapAttempt),
    }
  },
  async loadRunDetail(runId) {
    if (!isUuid(runId)) return undefined
    const detail = await one<
      JsonRecord & {
        run: unknown
        nodes: unknown
        children: unknown
        attempts: unknown
        child_runs: unknown
      }
    >(
      db,
      `
      SELECT
        (
          SELECT ${runSummaryJsonSql('r')}
          FROM workflow_runs r
          WHERE r.id = $1
        ) AS run,
        COALESCE(
          (
            SELECT jsonb_agg(to_jsonb(n) - 'input' - 'output')
            FROM workflow_nodes n
            WHERE n.run_id = $1
          ),
          '[]'::jsonb
        ) AS nodes,
        COALESCE(
          (
            SELECT jsonb_agg(
              to_jsonb(c) - 'item' - 'input' - 'output'
              ORDER BY c.node_name, c.ordinal, c.child_key
            )
            FROM workflow_node_children c
            WHERE c.run_id = $1
          ),
          '[]'::jsonb
        ) AS children,
        COALESCE(
          (
            SELECT jsonb_agg(
              to_jsonb(a) - 'input' - 'output'
              ORDER BY a.dispatched_at, a.id
            )
            FROM workflow_attempts a
            WHERE a.run_id = $1
          ),
          '[]'::jsonb
        ) AS attempts,
        COALESCE(
          (
            SELECT jsonb_agg(run_json ORDER BY created_at, id)
            FROM (
              SELECT DISTINCT ON (cr.id)
                cr.id,
                cr.created_at,
                ${runSummaryJsonSql('cr')} AS run_json
              FROM workflow_runs cr
              JOIN workflow_node_children c
                ON c.child_run_id = cr.id
               AND c.run_id = $1
              ORDER BY cr.id, cr.created_at
            ) child_runs
          ),
          '[]'::jsonb
        ) AS child_runs
    `,
      [runId],
    )
    const run = jsonRow<RunSummaryRow>(detail?.run)
    if (!run) return undefined

    return {
      run: mapRunSummary(run),
      nodes: jsonRows<NodeRow>(detail?.nodes).map(mapNodeSummary),
      children: jsonRows<ChildRow>(detail?.children).map(mapNodeChildSummary),
      attempts: jsonRows<AttemptRow>(detail?.attempts).map(mapAttemptSummary),
      childRuns: jsonRows<RunSummaryRow>(detail?.child_runs).map(mapRunSummary),
    }
  },
  async listRunFamily(runId) {
    if (!isUuid(runId)) return []
    const rows = await many<
      RunSummaryRow & {
        origin_node_name: string | null
        origin_child_key: string | null
      }
    >(
      db,
      `
      SELECT *
      FROM (
        SELECT DISTINCT ON (r.id)
          ${runSummaryColumnsSql('r')},
          c.node_name AS origin_node_name,
          c.child_key AS origin_child_key
        FROM workflow_runs r
        JOIN workflow_runs target
          ON target.id = $1
         AND r.root_run_id = target.root_run_id
        LEFT JOIN workflow_node_children c
          ON c.child_run_id = r.id
        ${nodeCountsJoinSql('r')}
        ORDER BY r.id, c.node_name, c.child_key
      ) family
      ORDER BY created_at ASC, id ASC
    `,
      [runId],
    )
    return rows.map((row) => ({
      run: mapRunSummary(row),
      ...(row.origin_node_name === null || row.origin_node_name === undefined
        ? {}
        : {
            origin: {
              nodeName: row.origin_node_name,
              childKey: row.origin_child_key as string,
            },
          }),
    }))
  },
  ...createDeadCommandStore(db),
})
