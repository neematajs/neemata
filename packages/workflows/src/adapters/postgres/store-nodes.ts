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
            status = 'running',
            version = version + 1,
            updated_at = now()
        WHERE run_id = $1 AND name = $2
          AND status IN (${nodeStatusSourcesSql('running', { self: true })})
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
      return db.transaction(async (tx) => {
        const child = await one(
          tx,
          `
          SELECT *
          FROM workflow_node_children
          WHERE run_id = $1 AND node_name = $2 AND child_key = $3
        `,
          [input.runId, input.nodeName, input.childKey],
        )
        if (!child) {
          throw new Error(
            `Missing node child [${input.runId}.${input.nodeName}.${input.childKey}]`,
          )
        }
        if (isTerminalNodeStatus(child.status as StoredNodeChild['status'])) {
          throw new Error(
            `Terminal node child [${input.runId}.${input.nodeName}.${input.childKey}] cannot create attempt`,
          )
        }

        const attemptId = id()
        const leaseToken = id()
        const attempt = await one(
          tx,
          `
          INSERT INTO workflow_attempts (
            id, run_id, node_name, child_key, status, lease_token,
            attempt_number, input, idempotency_key, dispatched_at
          )
          VALUES (
            $1, $2, $3, $4, 'started', $5, $6, $7::jsonb, $8::jsonb, now()
          )
          RETURNING *
        `,
          [
            attemptId,
            input.runId,
            input.nodeName,
            input.childKey,
            leaseToken,
            (child.attempt_count as number) + 1,
            json(input.input),
            input.idempotencyKey ? json(input.idempotencyKey) : null,
          ],
        )
        const updatedChild = await one(
          tx,
          `
          UPDATE workflow_node_children
          SET current_attempt_id = $4,
              attempt_count = attempt_count + 1,
              status = 'running',
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND node_name = $2 AND child_key = $3
            AND status IN (${nodeStatusSourcesSql('running', { self: true })})
          RETURNING *
        `,
          [input.runId, input.nodeName, input.childKey, attemptId],
        )
        if (!updatedChild) {
          throw new Error(
            `Terminal node child [${input.runId}.${input.nodeName}.${input.childKey}] cannot create attempt`,
          )
        }
        // Aggregate hint only: retrying a child means the node has local work
        // again, but never fail the retry when the node cannot move.
        await tx.query(
          `
          UPDATE workflow_nodes
          SET status = 'running', version = version + 1, updated_at = now()
          WHERE run_id = $1 AND name = $2
            AND status IN (${nodeStatusSourcesSql('running', { self: true })})
        `,
          [input.runId, input.nodeName],
        )
        return mapAttempt(attempt!)
      })
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
            UPDATE workflow_attempts
            SET status = 'completed', output = $3::jsonb, completed_at = now()
            WHERE id = $1 AND lease_token = $2 AND status = 'started'
            RETURNING *
          `,
            [attemptId, leaseToken, json(output)],
          )
          if (!row) return undefined
          const child = await one(
            tx,
            `
            UPDATE workflow_node_children
            SET status = 'completed',
                output = $5::jsonb,
                version = version + 1,
                updated_at = now()
            WHERE run_id = $1 AND node_name = $2 AND child_key = $3
              AND current_attempt_id = $4
              AND status IN (${nodeStatusSourcesSql('completed')})
            RETURNING *
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
      const attempt = await loadFencedAttempt(attemptId, leaseToken)
      if (!attempt) return undefined

      const row = await one(
        db,
        `
        UPDATE workflow_attempts
        SET status = 'failed', error = $3::jsonb, completed_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'started'
        RETURNING *
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
        UPDATE workflow_attempts
        SET status = 'timedOut', error = $3::jsonb, completed_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'started'
        RETURNING *
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
        UPDATE workflow_nodes
        SET status = 'completed',
            output = $3::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE run_id = $1 AND name = $2
          AND status IN (${nodeStatusSourcesSql('completed')})
        RETURNING *
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
        UPDATE workflow_nodes
        SET status = 'failed',
            error = $3::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE run_id = $1 AND name = $2
          AND status IN (${nodeStatusSourcesSql('failed')})
        RETURNING *
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
        UPDATE workflow_runs
        SET status = 'running',
            version = version + 1,
            updated_at = now()
        WHERE id = $1
          AND status IN (${runStatusSourcesSql('running')})
        RETURNING *
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
        UPDATE workflow_runs
        SET status = 'waiting',
            version = version + 1,
            updated_at = now()
        WHERE id = $1
          AND status IN (${runStatusSourcesSql('waiting')})
        RETURNING *
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
        UPDATE workflow_runs
        SET status = 'completed',
            output = $2::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE id = $1
          AND status IN (${runStatusSourcesSql('completed')})
        RETURNING *
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
        UPDATE workflow_runs
        SET status = 'failed',
            error = $2::jsonb,
            version = version + 1,
            updated_at = now()
        WHERE id = $1
          AND status IN (${runStatusSourcesSql('failed')})
        RETURNING *
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
          UPDATE workflow_runs
          SET status = 'cancelling',
              version = version + 1,
              updated_at = now()
          WHERE id = $1
            AND status IN (${runStatusSourcesSql('cancelling')})
          RETURNING *
        )
        SELECT updated.*,
          pg_notify('${WORKFLOW_CANCELLATIONS_CHANNEL}', updated.id::text)
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
        UPDATE workflow_runs
        SET status = 'cancelled',
            version = version + 1,
            updated_at = now()
        WHERE id = $1
          AND status IN (${runStatusSourcesSql('cancelled')})
        RETURNING *
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
        UPDATE workflow_nodes
        SET status = 'cancelled',
            version = version + 1,
            updated_at = now()
        WHERE run_id = $1 AND name = $2
          AND status IN (${nodeStatusSourcesSql('cancelled')})
        RETURNING *
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
          UPDATE workflow_nodes
          SET status = 'cancelled',
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1
            AND status IN (${nodeStatusSourcesSql('cancelled')})
          RETURNING *
        `,
          [runId],
        )
        await tx.query(
          `
          UPDATE workflow_node_children
          SET status = 'cancelled',
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1
            AND status IN (${nodeStatusSourcesSql('cancelled')})
        `,
          [runId],
        )
        return rows.map(mapNode)
      })
    },
  }
}
