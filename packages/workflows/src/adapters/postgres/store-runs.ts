import type { RunSnapshot, StoredRun } from '../../runtime/state.ts'
import type {
  CreateRunInput,
  DeleteRunResult,
  ListRunsFilter,
  PruneTerminalRunsParams,
  PruneTerminalRunsResult,
  TerminalRunStatus,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { JsonRecord } from './sql.ts'
import {
  id,
  isUniqueViolation,
  isUuid,
  json,
  jsonRecordArrayColumn,
  jsonRecordColumn,
  many,
  mapAttempt,
  mapAttemptSummary,
  mapDeadCommand,
  mapNode,
  mapNodeChild,
  mapNodeChildSummary,
  mapNodeSummary,
  mapRun,
  mapRunSummary,
  DEFAULT_PRUNE_STATUSES,
  normalizePruneBatchSize,
  normalizePruneStatuses,
  now,
  one,
  runnableName,
  sameValue,
  withDateColumns,
} from './sql.ts'

type PostgresWorkflowRunStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
}

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

export const createStoredRunWithState = async (
  connection: WorkflowPostgresConnection,
  input: CreateRunInput,
  options: { readonly recoverUniqueViolation?: boolean } = {},
): Promise<{ readonly run: StoredRun; readonly created: boolean }> => {
  const recoverUniqueViolation = options.recoverUniqueViolation ?? true
  const loadIdempotentRun = async () => {
    if (!input.idempotencyKey) return undefined
    const existing = await one(
      connection,
      'SELECT * FROM workflow_runs WHERE idempotency_key = $1::jsonb',
      [json(input.idempotencyKey)],
    )
    if (existing) {
      const run = mapRun(existing)
      if (
        run.kind === (input.kind ?? 'workflow') &&
        run.name === runnableName(input) &&
        run.workflowName === input.workflowName &&
        run.taskName === input.taskName &&
        run.parentRunId === input.parentRunId &&
        run.parentNodeName === input.parentNodeName &&
        run.rootRunId === (input.rootRunId ?? run.id) &&
        sameValue(run.input, input.input)
      ) {
        return run
      }
      throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
    }
    return undefined
  }
  const existing = await loadIdempotentRun()
  if (existing) return { run: existing, created: false }

  const date = now()
  const runId = id()
  try {
    const row = await one(
      connection,
      `
        INSERT INTO workflow_runs (
          id, kind, name, workflow_name, task_name, status, input,
          parent_run_id, parent_node_name, root_run_id, tags,
          idempotency_key, version, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'queued', $6::jsonb,
          $7, $8, $9, $10::jsonb, $11::jsonb, 1, $12, $12
        )
        RETURNING *
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
        date,
      ],
    )
    return { run: mapRun(row!), created: true }
  } catch (error) {
    if (
      recoverUniqueViolation &&
      input.idempotencyKey &&
      isUniqueViolation(error)
    ) {
      const raced = await loadIdempotentRun()
      if (raced) return { run: raced, created: false }
    }
    throw error
  }
}

export const createStoredRun = async (
  connection: WorkflowPostgresConnection,
  input: CreateRunInput,
  options: { readonly recoverUniqueViolation?: boolean } = {},
) => (await createStoredRunWithState(connection, input, options)).run

export const pruneTerminalRunsInTransaction = async (
  connection: WorkflowPostgresConnection,
  params: PruneTerminalRunsParams,
): Promise<PruneTerminalRunsResult> => {
  const batchSize = normalizePruneBatchSize(params.batchSize)
  const statuses = normalizePruneStatuses(params.statuses)
  let deleted = 0

  if (batchSize > 0 && statuses.length > 0) {
    const queryParams: unknown[] = [
      params.olderThan,
      ...statuses,
      ...DEFAULT_PRUNE_STATUSES,
      batchSize,
    ]
    const statusList = statuses.map((_, index) => `$${index + 2}`).join(', ')
    const terminalStatusOffset = statuses.length + 2
    const terminalStatusList = DEFAULT_PRUNE_STATUSES.map(
      (_, index) => `$${terminalStatusOffset + index}`,
    ).join(', ')
    const batchParam = `$${queryParams.length}`
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
                AND d.status NOT IN (${terminalStatusList})
            )
          ORDER BY r.updated_at, r.id
          LIMIT ${batchParam}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `,
      queryParams,
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

  const target = await one(
    connection,
    'SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE',
    [runId],
  )
  if (!target) return { deleted: false }
  if (target.parent_run_id !== null && target.parent_run_id !== undefined) {
    throw new Error(`Run [${runId}] is not a root run`)
  }

  const family = await many<{ id: string; status: string }>(
    connection,
    `
      SELECT id, status
      FROM workflow_runs
      WHERE root_run_id = $1
      ORDER BY created_at, id
      FOR UPDATE
    `,
    [runId],
  )
  if (
    family.some(
      (run) =>
        !DEFAULT_PRUNE_STATUSES.includes(run.status as TerminalRunStatus),
    )
  ) {
    throw new Error(`Run [${runId}] has non-terminal runs`)
  }

  const familyRunIds = family.map((run) => run.id)
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

type RunListQueryParts = {
  readonly params: unknown[]
  readonly whereSql: string
  readonly push: (value: unknown) => string
  readonly offset: number
  readonly limit: number | null
  readonly pageLimit: number | null
}

const runSummaryNodeCountsAlias = (alias: string) => `${alias}_node_counts`

const runSummaryNodeCountsJoinSql = (alias: string) => `
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS nodes_total,
      (count(*) FILTER (WHERE n.status = 'completed'))::int AS nodes_completed
    FROM workflow_nodes n
    WHERE n.run_id = ${alias}.id
  ) ${runSummaryNodeCountsAlias(alias)} ON true
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
  ${alias}.created_at,
  ${alias}.updated_at,
  ${runSummaryNodeCountsAlias(alias)}.nodes_total AS nodes_total,
  ${runSummaryNodeCountsAlias(alias)}.nodes_completed AS nodes_completed
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

const buildListRunsQueryParts = (
  filter: ListRunsFilter,
): RunListQueryParts | undefined => {
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

  const limit = filter.limit ?? null
  const pageLimit = limit === null ? null : limit + 1
  return {
    params,
    whereSql: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`,
    push,
    offset,
    limit,
    pageLimit,
  }
}

export const createPostgresWorkflowRunStore = (
  ctx: PostgresWorkflowRunStoreContext,
): PostgresWorkflowRunStore => {
  const { db, ready } = ctx

  return {
    async createRun(input) {
      await ready
      return createStoredRun(db, input)
    },
    async listRuns(filter: ListRunsFilter = {}) {
      await ready
      const query = buildListRunsQueryParts(filter)
      if (!query) return { runs: [] }
      const rows = await many(
        db,
        `
        SELECT r.*
        FROM workflow_runs r
        ${query.whereSql}
        ORDER BY r.created_at DESC, r.id DESC
        ${query.pageLimit === null ? '' : `LIMIT ${query.push(query.pageLimit)}`}
        OFFSET ${query.push(query.offset)}
      `,
        query.params,
      )
      const page = query.limit === null ? rows : rows.slice(0, query.limit)
      return {
        runs: page.map(mapRun),
        ...(query.limit !== null && rows.length > query.limit
          ? { nextCursor: String(query.offset + query.limit) }
          : {}),
      }
    },
    async listRunSummaries(filter: ListRunsFilter = {}) {
      await ready
      const query = buildListRunsQueryParts(filter)
      if (!query) return { runs: [] }
      const rows = await many(
        db,
        `
        SELECT ${runSummaryColumnsSql('r')}
        FROM workflow_runs r
        ${runSummaryNodeCountsJoinSql('r')}
        ${query.whereSql}
        ORDER BY r.created_at DESC, r.id DESC
        ${query.pageLimit === null ? '' : `LIMIT ${query.push(query.pageLimit)}`}
        OFFSET ${query.push(query.offset)}
      `,
        query.params,
      )
      const page = query.limit === null ? rows : rows.slice(0, query.limit)
      return {
        runs: page.map(mapRunSummary),
        ...(query.limit !== null && rows.length > query.limit
          ? { nextCursor: String(query.offset + query.limit) }
          : {}),
      }
    },
    async pruneTerminalRuns(params) {
      await ready
      return db.transaction((tx) => pruneTerminalRunsInTransaction(tx, params))
    },
    async deleteRun(runId) {
      await ready
      return db.transaction((tx) => deleteRunInTransaction(tx, runId))
    },
    async listDeadCommands(params) {
      await ready
      if (params?.runId !== undefined && !isUuid(params.runId)) return []
      const rows = await many(
        db,
        `
        SELECT *
        FROM workflow_commands
        WHERE dead_at IS NOT NULL
        ${params?.runId === undefined ? '' : 'AND run_id = $1'}
        ORDER BY dead_at DESC, created_at DESC, id ASC
      `,
        params?.runId === undefined ? [] : [params.runId],
      )
      return rows
        .map((row) => withDateColumns(row, ['dead_at', 'created_at', 'run_at']))
        .map(mapDeadCommand)
    },
    async listUnreapedDeadCommands(params) {
      await ready
      const limit = params?.limit
      const rows = await many(
        db,
        `
        SELECT *
        FROM workflow_commands
        WHERE dead_at IS NOT NULL
          AND reaped_at IS NULL
        ORDER BY dead_at ASC, created_at ASC, id ASC
        ${limit === undefined ? '' : 'LIMIT $1'}
      `,
        limit === undefined ? [] : [limit],
      )
      return rows
        .map((row) => withDateColumns(row, ['dead_at', 'created_at', 'run_at']))
        .map(mapDeadCommand)
    },
    async markDeadCommandReaped(commandId) {
      await ready
      await db.query(
        `
        UPDATE workflow_commands
        SET reaped_at = now()
        WHERE id = $1
          AND dead_at IS NOT NULL
          AND reaped_at IS NULL
      `,
        [commandId],
      )
    },
    async requeueDeadCommand(commandId) {
      await ready
      await db.query(
        `
        UPDATE workflow_commands
        SET delivery_count = 0,
            last_error = NULL,
            dead_at = NULL,
            reaped_at = NULL,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            run_at = now()
        WHERE id = $1
          AND dead_at IS NOT NULL
      `,
        [commandId],
      )
    },
    async acquireRunLease({ runId, leaseMs }) {
      await ready
      if (!isUuid(runId)) return undefined
      const lock = await one<{ acquired: boolean }>(
        db,
        `
        SELECT pg_try_advisory_xact_lock(hashtext('workflow_run_lease:' || $1::text)) AS acquired
      `,
        [runId],
      )
      if (!lock?.acquired) return undefined

      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined

      const leaseToken = id()
      const lease = await one(
        db,
        `
        INSERT INTO workflow_run_leases (run_id, lease_token, version, expires_at)
        VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'))
        ON CONFLICT (run_id) DO UPDATE
        SET lease_token = EXCLUDED.lease_token,
            version = EXCLUDED.version,
            expires_at = EXCLUDED.expires_at
        WHERE workflow_run_leases.expires_at <= now()
        RETURNING *
      `,
        [runId, leaseToken, run.version, leaseMs],
      )
      if (!lease) return undefined
      return {
        runId: lease.run_id as string,
        leaseToken: lease.lease_token as string,
        version: lease.version as number,
      }
    },
    async renewRunLease(lease, leaseMs) {
      await ready
      if (!isUuid(lease.runId)) return undefined
      const renewedLease = await one(
        db,
        `
        UPDATE workflow_run_leases
        SET expires_at = now() + ($3::int * interval '1 millisecond')
        WHERE run_id = $1 AND lease_token = $2
        RETURNING *
      `,
        [lease.runId, lease.leaseToken, leaseMs],
      )
      if (!renewedLease) return undefined
      return {
        runId: renewedLease.run_id as string,
        leaseToken: renewedLease.lease_token as string,
        version: renewedLease.version as number,
      }
    },
    async releaseRunLease(lease) {
      await ready
      if (!isUuid(lease.runId)) return
      await db.query(
        'DELETE FROM workflow_run_leases WHERE run_id = $1 AND lease_token = $2',
        [lease.runId, lease.leaseToken],
      )
    },
    async loadRuns(runIds) {
      await ready
      const ids = [...new Set(runIds)].filter(isUuid)
      if (ids.length === 0) return []
      const rows = await many(
        db,
        'SELECT * FROM workflow_runs WHERE id = ANY($1::uuid[])',
        [ids],
      )
      // ANY() returns rows in unspecified order; reorder to keep the
      // first-occurrence contract shared with the in-memory store.
      const runs = new Map(rows.map(mapRun).map((run) => [run.id, run]))
      return ids.flatMap((runId) => {
        const run = runs.get(runId)
        return run ? [run] : []
      })
    },
    async loadRunSnapshot(runId) {
      await ready
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
      const run = jsonRecordColumn(snapshot?.run)
      if (!run) return undefined

      const nodes = jsonRecordArrayColumn(snapshot.nodes).map((node) =>
        withDateColumns(node, ['created_at', 'updated_at']),
      )
      const children = jsonRecordArrayColumn(snapshot.children).map((child) =>
        withDateColumns(child, ['created_at', 'updated_at']),
      )
      const attempts = jsonRecordArrayColumn(snapshot.attempts).map((attempt) =>
        withDateColumns(attempt, [
          'dispatched_at',
          'heartbeat_at',
          'completed_at',
        ]),
      )

      return {
        run: mapRun(withDateColumns(run, ['created_at', 'updated_at'])),
        nodes: nodes.map(mapNode),
        children: children.map(mapNodeChild),
        attempts: attempts.map(mapAttempt),
      } satisfies RunSnapshot
    },
    async loadRunDetail(runId) {
      await ready
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
      const run = jsonRecordColumn(detail?.run)
      if (!run) return undefined

      const nodes = jsonRecordArrayColumn(detail.nodes).map((node) =>
        withDateColumns(node, ['created_at', 'updated_at']),
      )
      const children = jsonRecordArrayColumn(detail.children).map((child) =>
        withDateColumns(child, ['created_at', 'updated_at']),
      )
      const attempts = jsonRecordArrayColumn(detail.attempts).map((attempt) =>
        withDateColumns(attempt, [
          'dispatched_at',
          'heartbeat_at',
          'completed_at',
        ]),
      )
      const childRuns = jsonRecordArrayColumn(detail.child_runs).map(
        (childRun) => withDateColumns(childRun, ['created_at', 'updated_at']),
      )

      return {
        run: mapRunSummary(withDateColumns(run, ['created_at', 'updated_at'])),
        nodes: nodes.map(mapNodeSummary),
        children: children.map(mapNodeChildSummary),
        attempts: attempts.map(mapAttemptSummary),
        childRuns: childRuns.map(mapRunSummary),
      }
    },
    async listRunFamily(runId) {
      await ready
      if (!isUuid(runId)) return []
      const rows = await many(
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
          ${runSummaryNodeCountsJoinSql('r')}
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
                nodeName: row.origin_node_name as string,
                childKey: row.origin_child_key as string,
              },
            }),
      }))
    },
  }
}
