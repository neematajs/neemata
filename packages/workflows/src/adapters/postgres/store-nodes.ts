import type { StoredAttempt } from '../../runtime/state.ts'
import type { CreateAttemptInput, WorkflowStore } from '../../runtime/store.ts'
import type { JsonRecord, WorkflowPostgresConnection } from './connection.ts'
import type { AttemptRow, ChildRow, NodeRow } from './rows.ts'
import { toStoredError } from '../../runtime/errors.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../../runtime/status.ts'
import {
  TERMINAL_NODE_STATUSES_SQL,
  nodeStatusSourcesSql,
  statusNotify,
} from './fragments.ts'
import { id, isUuid, json, jsonRow, jsonRows, many, one } from './query.ts'
import {
  loadChild,
  loadNode,
  loadRun,
  mapAttempt,
  mapNode,
  mapNodeChild,
  mapRun,
} from './rows.ts'
import {
  transitionChildRow,
  transitionNode,
  transitionRun,
} from './transitions.ts'

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

type SettleAttempt = {
  readonly attemptId: string
  readonly leaseToken: string
  readonly to: 'completed' | 'failed' | 'timedOut'
  readonly event: string
  readonly column: 'output' | 'error'
  readonly value: unknown
  /**
   * Whether the current-attempt fence rides this statement. The completion
   * path settles the child in the same transaction and carries the fence on
   * that write instead.
   */
  readonly fenced: boolean
}

/**
 * Uniform current-attempt fencing: an attempt may only settle while its
 * child record still points at it and the child is non-terminal.
 */
const loadFencedAttempt = async (
  db: WorkflowPostgresConnection,
  attemptId: string,
  leaseToken: string,
) => {
  const attempt = await one<AttemptRow>(
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
  const child = await loadChild(
    db,
    attempt.run_id,
    attempt.node_name,
    attempt.child_key,
  )
  if (
    !child ||
    child.current_attempt_id !== attemptId ||
    isTerminalNodeStatus(child.status)
  ) {
    return undefined
  }
  return attempt
}

const settleAttempt = (
  db: WorkflowPostgresConnection,
  params: SettleAttempt,
) => {
  const notify = statusNotify(params.event, 'updated')
  const fenceJoin = params.fenced
    ? `JOIN workflow_node_children c ON c.run_id = a.run_id
        AND c.node_name = a.node_name AND c.child_key = a.child_key`
    : ''
  const fenceWhere = params.fenced
    ? `AND c.current_attempt_id = a.id
        AND c.status NOT IN (${TERMINAL_NODE_STATUSES_SQL})`
    : ''

  return one<AttemptRow>(
    db,
    `
    WITH candidate AS (
      SELECT a.id, a.status::text AS old_status, r.root_run_id
      FROM workflow_attempts a
      JOIN workflow_runs r ON r.id = a.run_id
      ${fenceJoin}
      WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'started'
        ${fenceWhere}
    ),
    updated AS (
      UPDATE workflow_attempts
      SET status = '${params.to}', ${params.column} = $3::jsonb, completed_at = now()
      FROM candidate
      WHERE workflow_attempts.id = candidate.id
      RETURNING workflow_attempts.*, candidate.old_status, candidate.root_run_id
    ),${notify.cte}
    SELECT updated.*${notify.columns}
    FROM updated
  `,
    [params.attemptId, params.leaseToken, json(params.value)],
  )
}

export const createAttempt = async (
  db: WorkflowPostgresConnection,
  input: CreateAttemptInput,
): Promise<StoredAttempt> => {
  const started = statusNotify('attempt_started', 'attempt_event_source')
  const childRunning = statusNotify('child_running', 'updated_child')
  const nodeRunning = statusNotify('node_running', 'updated_node')
  const running = nodeStatusSourcesSql('running', { self: true })
  // Lock the child before allocating its next attempt number. CTE dependencies
  // keep the attempt, child pointer and node hint atomic, including notifications.
  const attempt = await one<AttemptRow & { child_exists: boolean }>(
    db,
    `
    WITH child AS MATERIALIZED (
      SELECT c.*, r.root_run_id,
        COALESCE(a.retry_attempt_number, 0) + 1 AS next_retry_attempt_number
      FROM workflow_node_children c
      LEFT JOIN workflow_attempts a ON a.id = c.current_attempt_id
      JOIN workflow_runs r ON r.id = c.run_id
      WHERE c.run_id = $2 AND c.node_name = $3 AND c.child_key = $4
      FOR UPDATE OF c
    ), inserted AS (
      INSERT INTO workflow_attempts (
        id, run_id, node_name, child_key, status, lease_token,
        attempt_number, retry_attempt_number, input, idempotency_key, dispatched_at
      )
      SELECT $1, run_id, node_name, child_key, 'started', $5,
        attempt_count + 1, next_retry_attempt_number, $6::jsonb, $7::jsonb, now()
      FROM child
      WHERE status IN (${running})
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
        AND n.status IN (${running})
      RETURNING n.*, node.old_status, node.root_run_id
    ),${started.cte},${childRunning.cte},${nodeRunning.cte}
    SELECT inserted.*, EXISTS (SELECT 1 FROM child) AS child_exists${started.columns}${childRunning.columns}${nodeRunning.columns}
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
  const ref = `${input.runId}.${input.nodeName}.${input.childKey}`
  if (!attempt?.child_exists) throw new Error(`Missing node child [${ref}]`)
  if (!attempt.id) {
    throw new Error(`Terminal node child [${ref}] cannot create attempt`)
  }
  return mapAttempt(attempt)
}

export const createPostgresWorkflowNodeStore = (
  db: WorkflowPostgresConnection,
): PostgresWorkflowNodeStore => ({
  async createNode(input) {
    const date = new Date()
    // The no-op DO UPDATE is what makes RETURNING yield the existing row, so
    // re-entry reads the stored node instead of an empty result.
    const row = await one<NodeRow>(
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
    if (!row) throw new Error(`Missing node [${input.runId}.${input.name}]`)
    return mapNode(row)
  },
  async setNodeInput({ runId, nodeName, input }) {
    const row = await one<NodeRow>(
      db,
      `
      UPDATE workflow_nodes
      SET input = $3::jsonb,
          version = version + 1,
          updated_at = now()
      WHERE run_id = $1
        AND name = $2
        AND status NOT IN (${TERMINAL_NODE_STATUSES_SQL})
      RETURNING *
    `,
      [runId, nodeName, json(input)],
    )
    if (row) return mapNode(row)
    const current = await loadNode(db, runId, nodeName)
    if (!current) throw new Error(`Missing node [${runId}.${nodeName}]`)
    return mapNode(current)
  },
  async loadNodeSnapshot({ runId, nodeName }) {
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
    const node = jsonRow<NodeRow>(snapshot?.node)
    if (!node) return undefined

    return {
      node: mapNode(node),
      children: jsonRows<ChildRow>(snapshot?.children).map(mapNodeChild),
      attempts: jsonRows<AttemptRow>(snapshot?.attempts).map(mapAttempt),
    }
  },
  createAttempt: (input) => createAttempt(db, input),
  async completeCurrentAttempt({ attemptId, leaseToken, output }) {
    const attempt = await loadFencedAttempt(db, attemptId, leaseToken)
    if (!attempt) return undefined

    // The pre-check above is only a fast path; the fence must hold at write
    // time, so the child update re-checks it and a miss rolls back the
    // attempt update — attempt and child settle atomically or not at all.
    const rolledBack = Symbol('stale-attempt-fence')
    try {
      return await db.transaction(async (tx) => {
        const row = await settleAttempt(tx, {
          attemptId,
          leaseToken,
          to: 'completed',
          event: 'attempt_completed',
          column: 'output',
          value: output,
          fenced: false,
        })
        if (!row) return undefined
        const child = await transitionChildRow(
          tx,
          attempt.run_id,
          attempt.node_name,
          attempt.child_key,
          'completed',
          {
            on: 'AND c.current_attempt_id = $4',
            set: 'output = $5::jsonb',
            values: [attemptId, json(output)],
          },
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
    const row = await settleAttempt(db, {
      attemptId,
      leaseToken,
      to: 'failed',
      event: 'attempt_failed',
      column: 'error',
      value: toStoredError(error),
      fenced: true,
    })
    return row ? mapAttempt(row) : undefined
  },
  async timeoutCurrentAttempt({ attemptId, leaseToken, error }) {
    const attempt = await loadFencedAttempt(db, attemptId, leaseToken)
    if (!attempt) return undefined

    const row = await settleAttempt(db, {
      attemptId,
      leaseToken,
      to: 'timedOut',
      event: 'attempt_timed_out',
      column: 'error',
      value: toStoredError(error),
      fenced: true,
    })
    return row ? mapAttempt(row) : undefined
  },
  async completeNode({ runId, nodeName, output }) {
    const node = await loadNode(db, runId, nodeName)
    if (!node) return undefined
    if (isTerminalNodeStatus(node.status)) return mapNode(node)
    return transitionNode(db, runId, nodeName, 'completed', {
      set: 'output = $3::jsonb',
      values: [json(output)],
    })
  },
  async failNode({ runId, nodeName, error }) {
    const node = await loadNode(db, runId, nodeName)
    if (!node) return undefined
    if (isTerminalNodeStatus(node.status)) return mapNode(node)
    return transitionNode(db, runId, nodeName, 'failed', {
      set: 'error = $3::jsonb',
      values: [json(toStoredError(error))],
    })
  },
  markRunRunning: ({ runId }) => transitionRun(db, runId, 'running'),
  markRunWaiting: ({ runId }) => transitionRun(db, runId, 'waiting'),
  async completeRun({ runId, output }) {
    const run = await loadRun(db, runId)
    if (!run) return undefined
    if (isTerminalRunStatus(run.status)) return mapRun(run)
    return transitionRun(db, runId, 'completed', {
      set: 'output = $2::jsonb',
      values: [json(output)],
    })
  },
  async failRun({ runId, error }) {
    const run = await loadRun(db, runId)
    if (!run) return undefined
    if (isTerminalRunStatus(run.status)) return mapRun(run)
    return transitionRun(db, runId, 'failed', {
      set: 'error = $2::jsonb',
      values: [json(toStoredError(error))],
    })
  },
  async requestRunCancellation({ runId }) {
    const run = await loadRun(db, runId)
    if (!run) return undefined
    if (isTerminalRunStatus(run.status) || run.status === 'cancelling') {
      return mapRun(run)
    }
    return transitionRun(db, runId, 'cancelling', { notifyCancellation: true })
  },
  async cancelRun({ runId }) {
    const run = await loadRun(db, runId)
    if (!run) return undefined
    if (isTerminalRunStatus(run.status)) return mapRun(run)
    return transitionRun(db, runId, 'cancelled')
  },
  async cancelNode({ runId, nodeName }) {
    const node = await loadNode(db, runId, nodeName)
    if (!node) return undefined
    if (isTerminalNodeStatus(node.status)) return mapNode(node)
    return transitionNode(db, runId, nodeName, 'cancelled')
  },
  async cancelNonTerminalRunNodes({ runId }) {
    const nodes = statusNotify('nodes_cancelled', 'updated')
    const children = statusNotify('children_cancelled', 'updated')
    const attempts = statusNotify('attempts_cancelled', 'updated')
    const cancelled = nodeStatusSourcesSql('cancelled')

    return db.transaction(async (tx) => {
      const rows = await many<NodeRow>(
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
            AND workflow_nodes.status IN (${cancelled})
          RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
        ),${nodes.cte}
        SELECT updated.*${nodes.columns}
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
            AND workflow_node_children.status IN (${cancelled})
          RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
        ),${children.cte}
        SELECT count(*)${children.columns}
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
        ),${attempts.cte}
        SELECT count(*)${attempts.columns}
        FROM updated
      `,
        [runId],
      )
      return rows.map(mapNode)
    })
  },
})
