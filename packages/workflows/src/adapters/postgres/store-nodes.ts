import type {
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { JsonRecord } from './sql.ts'
import { toStoredError } from '../../runtime/errors.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../../runtime/status.ts'
import {
  WORKFLOW_CANCELLATIONS_CHANNEL,
  emitStatusChangeNotifySql,
  id,
  isUuid,
  jsonRecordArrayColumn,
  jsonRecordColumn,
  json,
  many,
  mapAttempt,
  mapNode,
  mapNodeChild,
  mapRun,
  nodeStatusSourcesSql,
  notifyRunStatusEventColumnsSql,
  one,
  runStatusSourcesSql,
  withDateColumns,
} from './sql.ts'

type PostgresWorkflowNodeStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
}

type PostgresWorkflowNodeStore = Pick<
  WorkflowStore,
  | 'createNode'
  | 'setNodeInput'
  | 'loadNodeSnapshot'
  | 'createAttempt'
  | 'completeCurrentAttempt'
  | 'failCurrentAttempt'
  | 'timeoutCurrentAttempt'
  | 'completeNode'
  | 'failNode'
  | 'markRunRunning'
  | 'markRunWaiting'
  | 'completeRun'
  | 'failRun'
  | 'requestRunCancellation'
  | 'cancelRun'
  | 'cancelNode'
  | 'cancelNonTerminalRunNodes'
>

type AttemptRow = {
  readonly run_id: string
  readonly node_name: string
  readonly child_key: string
}

export const createPostgresWorkflowNodeStore = (
  ctx: PostgresWorkflowNodeStoreContext,
): PostgresWorkflowNodeStore => {
  const { db, ready } = ctx

  /**
   * Uniform current-attempt fencing: an attempt may only settle while its
   * child record still points at it and the child is non-terminal.
   */
  const loadFencedAttempt = async (attemptId: string, leaseToken: string) => {
    const attempt = await one(
      db,
      'SELECT * FROM workflow_attempts WHERE id = $1',
      [attemptId],
    )
    if (
      !attempt ||
      attempt.lease_token !== leaseToken ||
      attempt.status !== 'started'
    ) {
      return undefined
    }
    const row = attempt as AttemptRow
    const child = await one(
      db,
      `
      SELECT *
      FROM workflow_node_children
      WHERE run_id = $1 AND node_name = $2 AND child_key = $3
    `,
      [row.run_id, row.node_name, row.child_key],
    )
    if (
      !child ||
      child.current_attempt_id !== attemptId ||
      isTerminalNodeStatus(child.status as StoredNodeChild['status'])
    ) {
      return undefined
    }
    return attempt
  }

  return {
    async createNode(input) {
      await ready
      const date = new Date()
      const row = await one(
        db,
        `
        INSERT INTO workflow_nodes (
          run_id, name, kind, status, version, created_at, updated_at
        )
        VALUES ($1, $2, $3, 'pending', 1, $4, $4)
        ON CONFLICT (run_id, name) DO UPDATE SET name = workflow_nodes.name
        RETURNING *
      `,
        [input.runId, input.name, input.kind, date],
      )
      return mapNode(row!)
    },
    async setNodeInput({ runId, nodeName, input }) {
      await ready
      const row = await one(
        db,
        `
        UPDATE workflow_nodes
        SET input = $3::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE run_id = $1
          AND name = $2
          AND status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING *
      `,
        [runId, nodeName, json(input)],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!current) throw new Error(`Missing node [${runId}.${nodeName}]`)
      return mapNode(current)
    },
    async loadNodeSnapshot({ runId, nodeName }) {
      await ready
      if (!isUuid(runId)) return undefined
      const snapshot = await one<
        JsonRecord & {
          node: unknown
          children: unknown
          attempts: unknown
        }
      >(
        db,
        `
        SELECT
          (
            SELECT to_jsonb(n)
            FROM workflow_nodes n
            WHERE n.run_id = $1 AND n.name = $2
          ) AS node,
          COALESCE(
            (
              SELECT jsonb_agg(to_jsonb(c) ORDER BY c.ordinal, c.child_key)
              FROM workflow_node_children c
              WHERE c.run_id = $1 AND c.node_name = $2
            ),
            '[]'::jsonb
          ) AS children,
          COALESCE(
            (
              SELECT jsonb_agg(to_jsonb(a) ORDER BY a.dispatched_at, a.id)
              FROM workflow_attempts a
              WHERE a.run_id = $1 AND a.node_name = $2
            ),
            '[]'::jsonb
          ) AS attempts
      `,
        [runId, nodeName],
      )
      const node = jsonRecordColumn(snapshot?.node)
      if (!node) return undefined

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
        node: mapNode(withDateColumns(node, ['created_at', 'updated_at'])),
        children: children.map(mapNodeChild),
        attempts: attempts.map(mapAttempt),
      }
    },
    async createAttempt(input) {
      await ready
      // Lock the child before allocating its next attempt number. CTE dependencies
      // keep the attempt, child pointer and node hint atomic, including notifications.
      const attempt = await one(
        db,
        `
        WITH child AS MATERIALIZED (
          SELECT c.*, r.root_run_id
          FROM workflow_node_children c
          JOIN workflow_runs r ON r.id = c.run_id
          WHERE c.run_id = $2 AND c.node_name = $3 AND c.child_key = $4
          FOR UPDATE OF c
        ), inserted AS (
          INSERT INTO workflow_attempts (
            id, run_id, node_name, child_key, status, lease_token,
            attempt_number, input, idempotency_key, dispatched_at
          )
          SELECT $1, run_id, node_name, child_key, 'started', $5,
            attempt_count + 1, $6::jsonb, $7::jsonb, now()
          FROM child
          WHERE status IN (${nodeStatusSourcesSql('running', { self: true })})
          RETURNING *, NULL::text AS old_status
        ), attempt_event_source AS (
          SELECT inserted.*, child.root_run_id FROM inserted CROSS JOIN child
        ), updated_child AS (
          UPDATE workflow_node_children c
          SET current_attempt_id = inserted.id,
            attempt_count = inserted.attempt_number, status = 'running',
            version = c.version + 1, updated_at = now()
          FROM inserted, child
          WHERE c.run_id = inserted.run_id AND c.node_name = inserted.node_name
            AND c.child_key = inserted.child_key
          RETURNING c.*, child.status::text AS old_status, child.root_run_id
        ), node AS (
          SELECT n.run_id, n.name, n.status::text AS old_status, c.root_run_id
          FROM workflow_nodes n JOIN updated_child c
            ON n.run_id = c.run_id AND n.name = c.node_name
        ), updated_node AS (
          UPDATE workflow_nodes n
          SET status = 'running', version = n.version + 1, updated_at = now()
          FROM node
          WHERE n.run_id = node.run_id AND n.name = node.name
            AND n.status IN (${nodeStatusSourcesSql('running', { self: true })})
          RETURNING n.*, node.old_status, node.root_run_id
        ), ${emitStatusChangeNotifySql('attempt_event_source', 'attempt_started')},
        ${emitStatusChangeNotifySql('updated_child', 'child_running')},
        ${emitStatusChangeNotifySql('updated_node', 'node_running')}
        SELECT inserted.*, EXISTS (SELECT 1 FROM child) AS child_exists
          ${notifyRunStatusEventColumnsSql('attempt_started', 'child_running', 'node_running')}
        FROM (SELECT 1) AS result LEFT JOIN inserted ON true
      `,
        [
          id(),
          input.runId,
          input.nodeName,
          input.childKey,
          id(),
          json(input.input),
          input.idempotencyKey ? json(input.idempotencyKey) : null,
        ],
      )
      if (!attempt?.child_exists) {
        throw new Error(
          `Missing node child [${input.runId}.${input.nodeName}.${input.childKey}]`,
        )
      }
      if (!attempt.id) {
        throw new Error(
          `Terminal node child [${input.runId}.${input.nodeName}.${input.childKey}] cannot create attempt`,
        )
      }
      return mapAttempt(attempt)
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      await ready
      const attempt = await loadFencedAttempt(attemptId, leaseToken)
      if (!attempt) return undefined
      const { run_id, node_name, child_key } = attempt as AttemptRow

      // The pre-check above is only a fast path; the fence must hold at write
      // time, so the child update re-checks it and a miss rolls back the
      // attempt update — attempt and child settle atomically or not at all.
      const rolledBack = Symbol('stale-attempt-fence')
      try {
        return await db.transaction(async (tx) => {
          const row = await one(
            tx,
            `
            WITH candidate AS (
              SELECT a.id, a.status::text AS old_status, r.root_run_id
              FROM workflow_attempts a
              JOIN workflow_runs r ON r.id = a.run_id
              WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'started'
            ),
            updated AS (
            UPDATE workflow_attempts
            SET status = 'completed', output = $3::jsonb, completed_at = now()
            FROM candidate
            WHERE workflow_attempts.id = candidate.id
            RETURNING workflow_attempts.*, candidate.old_status, candidate.root_run_id
            ),
            ${emitStatusChangeNotifySql('updated', 'attempt_completed')}
            SELECT updated.*${notifyRunStatusEventColumnsSql('attempt_completed')}
            FROM updated
          `,
            [attemptId, leaseToken, json(output)],
          )
          if (!row) return undefined
          const child = await one(
            tx,
            `
            WITH candidate AS (
              SELECT c.run_id, c.node_name, c.child_key,
                c.status::text AS old_status, r.root_run_id
              FROM workflow_node_children c
              JOIN workflow_runs r ON r.id = c.run_id
              WHERE c.run_id = $1 AND c.node_name = $2 AND c.child_key = $3
                AND c.current_attempt_id = $4
            ),
            updated AS (
            UPDATE workflow_node_children
            SET status = 'completed',
                output = $5::jsonb,
                version = version + 1,
                updated_at = now()
            FROM candidate
            WHERE workflow_node_children.run_id = candidate.run_id
              AND workflow_node_children.node_name = candidate.node_name
              AND workflow_node_children.child_key = candidate.child_key
              AND workflow_node_children.status IN (${nodeStatusSourcesSql('completed')})
            RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
            ),
            ${emitStatusChangeNotifySql('updated', 'child_completed')}
            SELECT updated.*${notifyRunStatusEventColumnsSql('child_completed')}
            FROM updated
          `,
            [run_id, node_name, child_key, attemptId, json(output)],
          )
          if (!child) throw rolledBack
          return mapAttempt(row)
        })
      } catch (error) {
        if (error === rolledBack) return undefined
        throw error
      }
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      await ready
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT a.id, a.status::text AS old_status, r.root_run_id
          FROM workflow_attempts a
          JOIN workflow_runs r ON r.id = a.run_id
          JOIN workflow_node_children c ON c.run_id = a.run_id
            AND c.node_name = a.node_name AND c.child_key = a.child_key
          WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'started'
            AND c.current_attempt_id = a.id
            AND c.status NOT IN ('completed', 'failed', 'cancelled')
        ),
        updated AS (
        UPDATE workflow_attempts
        SET status = 'failed', error = $3::jsonb, completed_at = now()
        FROM candidate
        WHERE workflow_attempts.id = candidate.id
        RETURNING workflow_attempts.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'attempt_failed')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('attempt_failed')}
        FROM updated
      `,
        [attemptId, leaseToken, json(toStoredError(error))],
      )
      return row ? mapAttempt(row) : undefined
    },
    async timeoutCurrentAttempt({ attemptId, leaseToken, error }) {
      await ready
      const attempt = await loadFencedAttempt(attemptId, leaseToken)
      if (!attempt) return undefined

      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT a.id, a.status::text AS old_status, r.root_run_id
          FROM workflow_attempts a
          JOIN workflow_runs r ON r.id = a.run_id
          WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'started'
        ),
        updated AS (
        UPDATE workflow_attempts
        SET status = 'timedOut', error = $3::jsonb, completed_at = now()
        FROM candidate
        WHERE workflow_attempts.id = candidate.id
        RETURNING workflow_attempts.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'attempt_timed_out')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('attempt_timed_out')}
        FROM updated
      `,
        [attemptId, leaseToken, json(toStoredError(error))],
      )
      return row ? mapAttempt(row) : undefined
    },
    async completeNode({ runId, nodeName, output }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status as StoredNode['status'])) {
        return mapNode(node)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT n.run_id, n.name, n.status::text AS old_status, r.root_run_id
          FROM workflow_nodes n
          JOIN workflow_runs r ON r.id = n.run_id
          WHERE n.run_id = $1 AND n.name = $2
        ),
        updated AS (
        UPDATE workflow_nodes
        SET status = 'completed',
            output = $3::jsonb,
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_nodes.run_id = candidate.run_id
          AND workflow_nodes.name = candidate.name
          AND workflow_nodes.status IN (${nodeStatusSourcesSql('completed')})
        RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'node_completed')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('node_completed')}
        FROM updated
      `,
        [runId, nodeName, json(output)],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
    },
    async failNode({ runId, nodeName, error }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status as StoredNode['status'])) {
        return mapNode(node)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT n.run_id, n.name, n.status::text AS old_status, r.root_run_id
          FROM workflow_nodes n
          JOIN workflow_runs r ON r.id = n.run_id
          WHERE n.run_id = $1 AND n.name = $2
        ),
        updated AS (
        UPDATE workflow_nodes
        SET status = 'failed',
            error = $3::jsonb,
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_nodes.run_id = candidate.run_id
          AND workflow_nodes.name = candidate.name
          AND workflow_nodes.status IN (${nodeStatusSourcesSql('failed')})
        RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'node_failed')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('node_failed')}
        FROM updated
      `,
        [runId, nodeName, json(toStoredError(error))],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
    },
    async markRunRunning({ runId }) {
      await ready
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT id, status::text AS old_status
          FROM workflow_runs
          WHERE id = $1
        ),
        updated AS (
        UPDATE workflow_runs
        SET status = 'running',
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_runs.id = candidate.id
          AND workflow_runs.status IN (${runStatusSourcesSql('running')})
        RETURNING workflow_runs.*, candidate.old_status
        ),
        ${emitStatusChangeNotifySql('updated', 'run_running')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('run_running')}
        FROM updated
      `,
        [runId],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async markRunWaiting({ runId }) {
      await ready
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT id, status::text AS old_status
          FROM workflow_runs
          WHERE id = $1
        ),
        updated AS (
        UPDATE workflow_runs
        SET status = 'waiting',
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_runs.id = candidate.id
          AND workflow_runs.status IN (${runStatusSourcesSql('waiting')})
        RETURNING workflow_runs.*, candidate.old_status
        ),
        ${emitStatusChangeNotifySql('updated', 'run_waiting')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('run_waiting')}
        FROM updated
      `,
        [runId],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async completeRun({ runId, output }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (isTerminalRunStatus(run.status as StoredRun['status'])) {
        return mapRun(run)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT id, status::text AS old_status
          FROM workflow_runs
          WHERE id = $1
        ),
        updated AS (
        UPDATE workflow_runs
        SET status = 'completed',
            output = $2::jsonb,
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_runs.id = candidate.id
          AND workflow_runs.status IN (${runStatusSourcesSql('completed')})
        RETURNING workflow_runs.*, candidate.old_status
        ),
        ${emitStatusChangeNotifySql('updated', 'run_completed')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('run_completed')}
        FROM updated
      `,
        [runId, json(output)],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async failRun({ runId, error }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (isTerminalRunStatus(run.status as StoredRun['status'])) {
        return mapRun(run)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT id, status::text AS old_status
          FROM workflow_runs
          WHERE id = $1
        ),
        updated AS (
        UPDATE workflow_runs
        SET status = 'failed',
            error = $2::jsonb,
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_runs.id = candidate.id
          AND workflow_runs.status IN (${runStatusSourcesSql('failed')})
        RETURNING workflow_runs.*, candidate.old_status
        ),
        ${emitStatusChangeNotifySql('updated', 'run_failed')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('run_failed')}
        FROM updated
      `,
        [runId, json(toStoredError(error))],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async requestRunCancellation({ runId }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (
        isTerminalRunStatus(run.status as StoredRun['status']) ||
        run.status === 'cancelling'
      ) {
        return mapRun(run)
      }
      // pg_notify rides on the status flip so a worker holding the attempt
      // can abort immediately instead of waiting out its heartbeat cycle.
      const row = await one(
        db,
        `
        WITH updated AS (
          WITH candidate AS (
            SELECT id, status::text AS old_status
            FROM workflow_runs
            WHERE id = $1
          )
          UPDATE workflow_runs
          SET status = 'cancelling',
              version = version + 1,
              updated_at = now()
          FROM candidate
          WHERE workflow_runs.id = candidate.id
            AND workflow_runs.status IN (${runStatusSourcesSql('cancelling')})
          RETURNING workflow_runs.*, candidate.old_status
        ),
        ${emitStatusChangeNotifySql('updated', 'run_cancelling')},
        cancellation_notified AS (
          SELECT pg_notify('${WORKFLOW_CANCELLATIONS_CHANNEL}', id::text)
          FROM updated
        )
        SELECT updated.*${notifyRunStatusEventColumnsSql('run_cancelling')},
          (SELECT count(*) FROM cancellation_notified) AS cancellation_notified
        FROM updated
      `,
        [runId],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async cancelRun({ runId }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (isTerminalRunStatus(run.status as StoredRun['status'])) {
        return mapRun(run)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT id, status::text AS old_status
          FROM workflow_runs
          WHERE id = $1
        ),
        updated AS (
        UPDATE workflow_runs
        SET status = 'cancelled',
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_runs.id = candidate.id
          AND workflow_runs.status IN (${runStatusSourcesSql('cancelled')})
        RETURNING workflow_runs.*, candidate.old_status
        ),
        ${emitStatusChangeNotifySql('updated', 'run_cancelled')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('run_cancelled')}
        FROM updated
      `,
        [runId],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async cancelNode({ runId, nodeName }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status as StoredNode['status'])) {
        return mapNode(node)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT n.run_id, n.name, n.status::text AS old_status, r.root_run_id
          FROM workflow_nodes n
          JOIN workflow_runs r ON r.id = n.run_id
          WHERE n.run_id = $1 AND n.name = $2
        ),
        updated AS (
        UPDATE workflow_nodes
        SET status = 'cancelled',
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_nodes.run_id = candidate.run_id
          AND workflow_nodes.name = candidate.name
          AND workflow_nodes.status IN (${nodeStatusSourcesSql('cancelled')})
        RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'node_cancelled')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('node_cancelled')}
        FROM updated
      `,
        [runId, nodeName],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
    },
    async cancelNonTerminalRunNodes({ runId }) {
      await ready
      return db.transaction(async (tx) => {
        const rows = await many(
          tx,
          `
          WITH candidate AS (
            SELECT n.run_id, n.name, n.status::text AS old_status, r.root_run_id
            FROM workflow_nodes n
            JOIN workflow_runs r ON r.id = n.run_id
            WHERE n.run_id = $1
          ),
          updated AS (
          UPDATE workflow_nodes
          SET status = 'cancelled',
              version = version + 1,
              updated_at = now()
          FROM candidate
          WHERE workflow_nodes.run_id = candidate.run_id
            AND workflow_nodes.name = candidate.name
            AND workflow_nodes.status IN (${nodeStatusSourcesSql('cancelled')})
          RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
          ),
          ${emitStatusChangeNotifySql('updated', 'nodes_cancelled')}
          SELECT updated.*${notifyRunStatusEventColumnsSql('nodes_cancelled')}
          FROM updated
        `,
          [runId],
        )
        await tx.query(
          `
          WITH candidate AS (
            SELECT c.run_id, c.node_name, c.child_key,
              c.status::text AS old_status, r.root_run_id
            FROM workflow_node_children c
            JOIN workflow_runs r ON r.id = c.run_id
            WHERE c.run_id = $1
          ),
          updated AS (
          UPDATE workflow_node_children
          SET status = 'cancelled',
              version = version + 1,
              updated_at = now()
          FROM candidate
          WHERE workflow_node_children.run_id = candidate.run_id
            AND workflow_node_children.node_name = candidate.node_name
            AND workflow_node_children.child_key = candidate.child_key
            AND workflow_node_children.status IN (${nodeStatusSourcesSql('cancelled')})
          RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
          ),
          ${emitStatusChangeNotifySql('updated', 'children_cancelled')}
          SELECT count(*)${notifyRunStatusEventColumnsSql('children_cancelled')}
          FROM updated
        `,
          [runId],
        )
        await tx.query(
          `
          WITH candidate AS (
            SELECT a.id, a.status::text AS old_status, r.root_run_id
            FROM workflow_attempts a
            JOIN workflow_runs r ON r.id = a.run_id
            WHERE a.run_id = $1 AND a.status = 'started'
          ),
          updated AS (
          UPDATE workflow_attempts
          SET status = 'cancelled', completed_at = now()
          FROM candidate
          WHERE workflow_attempts.id = candidate.id
          RETURNING workflow_attempts.*, candidate.old_status, candidate.root_run_id
          ),
          ${emitStatusChangeNotifySql('updated', 'attempts_cancelled')}
          SELECT count(*)${notifyRunStatusEventColumnsSql('attempts_cancelled')}
          FROM updated
        `,
          [runId],
        )
        return rows.map(mapNode)
      })
    },
  }
}
