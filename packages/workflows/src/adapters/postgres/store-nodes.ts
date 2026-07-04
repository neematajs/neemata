import type { StoredNode, StoredRun } from '../../runtime/state.ts'
import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { toStoredError } from '../../runtime/errors.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../../runtime/status.ts'
import { id, json, many, mapAttempt, mapNode, mapRun, one } from './sql.ts'

type PostgresWorkflowNodeStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
}

type PostgresWorkflowNodeStore = Pick<
  WorkflowStore,
  | 'createNode'
  | 'setNodeInput'
  | 'createAttempt'
  | 'completeCurrentAttempt'
  | 'failCurrentAttempt'
  | 'timeoutCurrentAttempt'
  | 'completeNode'
  | 'failNode'
  | 'completeRun'
  | 'failRun'
  | 'requestRunCancellation'
  | 'cancelRun'
  | 'cancelNode'
  | 'cancelNonTerminalRunNodes'
>

export const createPostgresWorkflowNodeStore = (
  ctx: PostgresWorkflowNodeStoreContext,
): PostgresWorkflowNodeStore => {
  const { db, ready } = ctx

  return {
    async createNode(input) {
      await ready
      const date = new Date()
      const row = await one(
        db,
        `
        INSERT INTO workflow_nodes (
          run_id, name, kind, status, attempt_count, version, created_at, updated_at
        )
        VALUES ($1, $2, $3, 'pending', 0, 1, $4, $4)
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
    async createAttempt(input) {
      await ready
      return db.transaction(async (tx) => {
        const node = await one(
          tx,
          'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
          [input.runId, input.nodeName],
        )
        if (!node) {
          throw new Error(`Missing node [${input.runId}.${input.nodeName}]`)
        }

        const attemptId = id()
        const leaseToken = id()
        const attempt = await one(
          tx,
          `
          INSERT INTO workflow_attempts (
            id, run_id, node_name, status, lease_token, attempt_number,
            input, idempotency_key, dispatched_at
          )
          VALUES (
            $1, $2, $3, 'started', $4, $5, $6::jsonb, $7::jsonb, now()
          )
          RETURNING *
        `,
          [
            attemptId,
            input.runId,
            input.nodeName,
            leaseToken,
            (node.attempt_count as number) + 1,
            json(input.input),
            input.idempotencyKey ? json(input.idempotencyKey) : null,
          ],
        )
        const updatedNode = await one(
          tx,
          `
          UPDATE workflow_nodes
          SET status = 'running',
              current_attempt_id = $3,
              attempt_count = attempt_count + 1,
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND name = $2
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
          [input.runId, input.nodeName, attemptId],
        )
        if (!updatedNode) {
          throw new Error(
            `Terminal node [${input.runId}.${input.nodeName}] cannot create attempt`,
          )
        }
        return mapAttempt(attempt!)
      })
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      await ready
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
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [attempt.run_id, attempt.node_name],
      )
      if (
        !node ||
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
        (node.kind !== 'parallel' && node.current_attempt_id !== attemptId)
      ) {
        return undefined
      }

      const row = await one(
        db,
        `
        UPDATE workflow_attempts
        SET status = 'completed', output = $3::jsonb, completed_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'started'
        RETURNING *
      `,
        [attemptId, leaseToken, json(output)],
      )
      return row ? mapAttempt(row) : undefined
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      await ready
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
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [attempt.run_id, attempt.node_name],
      )
      if (
        !node ||
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
        (node.kind !== 'parallel' && node.current_attempt_id !== attemptId)
      ) {
        return undefined
      }

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
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [attempt.run_id, attempt.node_name],
      )
      if (
        !node ||
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
        (node.kind !== 'parallel' && node.current_attempt_id !== attemptId)
      ) {
        return undefined
      }

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
          AND status NOT IN ('completed', 'failed', 'cancelled')
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
          AND status NOT IN ('completed', 'failed', 'cancelled')
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
          AND status NOT IN ('completed', 'failed', 'cancelled')
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
          AND status NOT IN ('completed', 'failed', 'cancelled')
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
      const row = await one(
        db,
        `
	          UPDATE workflow_runs
	          SET status = 'cancelling',
	              version = version + 1,
	              updated_at = now()
	          WHERE id = $1
	            AND status NOT IN ('cancelling', 'completed', 'failed', 'cancelled')
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
          AND status NOT IN ('completed', 'failed', 'cancelled')
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
	            AND status NOT IN ('completed', 'failed', 'cancelled')
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
      const rows = await many(
        db,
        `
	          UPDATE workflow_nodes
	          SET status = 'cancelled',
	              version = version + 1,
	              updated_at = now()
	          WHERE run_id = $1
	            AND status NOT IN ('completed', 'failed', 'cancelled')
	          RETURNING *
	        `,
        [runId],
      )
      return rows.map(mapNode)
    },
  }
}
