import type { RunSnapshot } from '../../runtime/state.ts'
import type {
  CreateRunInput,
  ListRunsFilter,
  PruneTerminalRunsParams,
  PruneTerminalRunsResult,
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
  mapChildLink,
  mapDeadCommand,
  mapMapItem,
  mapNode,
  mapRun,
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
  | 'pruneTerminalRuns'
  | 'listDeadCommands'
  | 'requeueDeadCommand'
  | 'acquireRunLease'
  | 'renewRunLease'
  | 'releaseRunLease'
  | 'loadRunSnapshot'
>

export const createStoredRun = async (
  connection: WorkflowPostgresConnection,
  input: CreateRunInput,
  options: { readonly recoverUniqueViolation?: boolean } = {},
) => {
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
  if (existing) return existing

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
    return mapRun(row!)
  } catch (error) {
    if (
      recoverUniqueViolation &&
      input.idempotencyKey &&
      isUniqueViolation(error)
    ) {
      const raced = await loadIdempotentRun()
      if (raced) return raced
    }
    throw error
  }
}
export const pruneTerminalRunsInTransaction = async (
  connection: WorkflowPostgresConnection,
  params: PruneTerminalRunsParams,
): Promise<PruneTerminalRunsResult> => {
  const batchSize = normalizePruneBatchSize(params.batchSize)
  const statuses = normalizePruneStatuses(params.statuses)
  let deleted = 0

  if (batchSize > 0 && statuses.length > 0) {
    const queryParams: unknown[] = [params.olderThan, ...statuses, batchSize]
    const statusList = statuses.map((_, index) => `$${index + 2}`).join(', ')
    const batchParam = `$${queryParams.length}`
    const rows = await many<{ id: string }>(
      connection,
      `
        DELETE FROM workflow_runs
        WHERE id IN (
          SELECT id
          FROM workflow_runs
          WHERE parent_run_id IS NULL
            AND status IN (${statusList})
            AND updated_at < $1
          ORDER BY updated_at, id
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
      if (
        filter.limit !== undefined &&
        (!Number.isFinite(filter.limit) || filter.limit < 1)
      ) {
        return { runs: [] }
      }

      const params: unknown[] = []
      const where: string[] = []
      const push = (value: unknown) => {
        params.push(value)
        return `$${params.length}`
      }

      if (filter.kind !== undefined) where.push(`kind = ${push(filter.kind)}`)
      if (filter.name !== undefined) where.push(`name = ${push(filter.name)}`)
      if (filter.status !== undefined) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status]
        where.push(
          `status IN (${statuses.map((status) => push(status)).join(', ')})`,
        )
      }
      if (filter.parentRunId !== undefined) {
        if (!isUuid(filter.parentRunId)) return { runs: [] }
        where.push(`parent_run_id = ${push(filter.parentRunId)}`)
      }
      if (filter.rootRunId !== undefined) {
        if (!isUuid(filter.rootRunId)) return { runs: [] }
        where.push(`root_run_id = ${push(filter.rootRunId)}`)
      }
      if (filter.tags !== undefined) {
        where.push(`tags @> ${push(json(filter.tags))}::jsonb`)
      }
      if (filter.input !== undefined) {
        where.push(`input @> ${push(json(filter.input))}::jsonb`)
      }

      const offset = filter.cursor ? Number.parseInt(filter.cursor, 10) : 0
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`Invalid run list cursor [${filter.cursor}]`)
      }

      const limit = filter.limit ?? null
      const pageLimit = limit === null ? null : limit + 1
      const rows = await many(
        db,
        `
        SELECT *
        FROM workflow_runs
        ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY created_at DESC, id DESC
        ${pageLimit === null ? '' : `LIMIT ${push(pageLimit)}`}
        OFFSET ${push(offset)}
      `,
        params,
      )
      const page = limit === null ? rows : rows.slice(0, limit)
      return {
        runs: page.map(mapRun),
        ...(limit !== null && rows.length > limit
          ? { nextCursor: String(offset + limit) }
          : {}),
      }
    },
    async pruneTerminalRuns(params) {
      await ready
      return db.transaction((tx) => pruneTerminalRunsInTransaction(tx, params))
    },
    async listDeadCommands() {
      await ready
      const rows = await many(
        db,
        `
        SELECT *
        FROM workflow_commands
        WHERE dead_at IS NOT NULL
        ORDER BY dead_at DESC, created_at DESC, id ASC
      `,
      )
      return rows
        .map((row) => withDateColumns(row, ['dead_at', 'created_at', 'run_at']))
        .map(mapDeadCommand)
    },
    async requeueDeadCommand(commandId) {
      await ready
      await db.query(
        `
        UPDATE workflow_commands
        SET delivery_count = 0,
            last_error = NULL,
            dead_at = NULL,
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
    async loadRunSnapshot(runId) {
      await ready
      if (!isUuid(runId)) return undefined
      const snapshot = await one<
        JsonRecord & {
          run: unknown
          nodes: unknown
          attempts: unknown
          child_links: unknown
          map_items: unknown
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
            (SELECT jsonb_agg(to_jsonb(a)) FROM workflow_attempts a WHERE a.run_id = $1),
            '[]'::jsonb
          ) AS attempts,
          COALESCE(
            (
              SELECT jsonb_agg(to_jsonb(c))
              FROM workflow_child_links c
              WHERE c.parent_run_id = $1
            ),
            '[]'::jsonb
          ) AS child_links,
          COALESCE(
            (SELECT jsonb_agg(to_jsonb(m)) FROM workflow_map_items m WHERE m.run_id = $1),
            '[]'::jsonb
          ) AS map_items
      `,
        [runId],
      )
      const run = jsonRecordColumn(snapshot?.run)
      if (!run) return undefined

      const nodes = jsonRecordArrayColumn(snapshot.nodes).map((node) =>
        withDateColumns(node, ['created_at', 'updated_at', 'next_attempt_at']),
      )
      const attempts = jsonRecordArrayColumn(snapshot.attempts).map((attempt) =>
        withDateColumns(attempt, [
          'dispatched_at',
          'heartbeat_at',
          'completed_at',
        ]),
      )
      const childLinks = jsonRecordArrayColumn(snapshot.child_links)
      const mapItems = jsonRecordArrayColumn(snapshot.map_items)

      return {
        run: mapRun(withDateColumns(run, ['created_at', 'updated_at'])),
        nodes: nodes.map(mapNode),
        attempts: attempts.map(mapAttempt),
        childLinks: childLinks.map(mapChildLink),
        mapItems: mapItems.map(mapMapItem),
      } satisfies RunSnapshot
    },
  }
}
