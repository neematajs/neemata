import type {
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { CreateRunInput, WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { toStoredError } from '../../runtime/errors.ts'
import { isTerminalNodeStatus } from '../../runtime/status.ts'
import {
  emitStatusChangeNotifySql,
  id,
  isUniqueViolation,
  json,
  many,
  mapAttempt,
  mapNode,
  mapNodeChild,
  mapRun,
  nodeStatusSourcesSql,
  notifyRunStatusEventColumnsSql,
  one,
  sameOptionalValue,
  sameValue,
} from './sql.ts'
import { WorkflowRunInsertConflict } from './store-runs.ts'

type CreateStoredRun = (
  connection: WorkflowPostgresConnection,
  input: CreateRunInput,
  options?: { readonly recoverUniqueViolation?: boolean },
) => Promise<StoredRun>

type PostgresWorkflowChildStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
  readonly createStoredRun: CreateStoredRun
}

type PostgresWorkflowChildStore = Pick<
  WorkflowStore,
  | 'ensureNodeChildren'
  | 'ensureChildRun'
  | 'ensureChildAttempt'
  | 'selectNodeCase'
  | 'completeNodeChild'
  | 'failNodeChild'
  | 'waitNode'
  | 'loadNodeChildren'
>

const childRef = (runId: string, nodeName: string, childKey: string) =>
  `${runId}.${nodeName}.${childKey}`

export const createPostgresWorkflowChildStore = (
  ctx: PostgresWorkflowChildStoreContext,
): PostgresWorkflowChildStore => {
  const { db, ready, createStoredRun } = ctx

  const loadChild = (
    connection: WorkflowPostgresConnection,
    runId: string,
    nodeName: string,
    childKey: string,
  ) =>
    one(
      connection,
      `
      SELECT *
      FROM workflow_node_children
      WHERE run_id = $1 AND node_name = $2 AND child_key = $3
    `,
      [runId, nodeName, childKey],
    )

  const loadOrderedChildren = (
    connection: WorkflowPostgresConnection,
    runId: string,
    nodeName: string,
  ) =>
    many(
      connection,
      `
      SELECT *
      FROM workflow_node_children
      WHERE run_id = $1 AND node_name = $2
      ORDER BY ordinal ASC, child_key ASC
    `,
      [runId, nodeName],
    )

  const loadLatestChildAttempt = (
    connection: WorkflowPostgresConnection,
    runId: string,
    nodeName: string,
    childKey: string,
  ) =>
    one(
      connection,
      `
      SELECT *
      FROM workflow_attempts
      WHERE run_id = $1 AND node_name = $2 AND child_key = $3
      ORDER BY attempt_number DESC
      LIMIT 1
    `,
      [runId, nodeName, childKey],
    )

  const childStore: PostgresWorkflowChildStore = {
    async ensureNodeChildren({ runId, nodeName, children }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) throw new Error(`Missing node [${runId}.${nodeName}]`)

      const loadExisting = async (connection: WorkflowPostgresConnection) => {
        const rows = await loadOrderedChildren(connection, runId, nodeName)
        if (rows.length === 0) return undefined
        const existing = rows.map(mapNodeChild)
        const matches =
          existing.length === children.length &&
          children.every((requested) => {
            const stored = existing.find(
              (child) => child.childKey === requested.childKey,
            )
            return (
              stored !== undefined &&
              stored.kind === requested.kind &&
              stored.ordinal === (requested.ordinal ?? 0) &&
              stored.itemKey === requested.itemKey &&
              sameOptionalValue(stored.item, requested.item)
            )
          })
        if (!matches) {
          throw new Error(`Conflicting node children [${runId}.${nodeName}]`)
        }
        return { children: existing, created: false }
      }
      const existing = await loadExisting(db)
      if (existing) return existing

      try {
        return await db.transaction(async (tx) => {
          const raced = await loadExisting(tx)
          if (raced) return raced

          for (const child of children) {
            await tx.query(
              `
              INSERT INTO workflow_node_children (
                run_id, node_name, child_key, kind, status, ordinal,
                item_key, item, attempt_count, version, created_at, updated_at
              )
              VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb, 0, 1, now(), now())
            `,
              [
                runId,
                nodeName,
                child.childKey,
                child.kind,
                child.ordinal ?? 0,
                child.itemKey ?? null,
                child.item === undefined ? null : json(child.item),
              ],
            )
          }
          const rows = await loadOrderedChildren(tx, runId, nodeName)
          return { children: rows.map(mapNodeChild), created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadExisting(db)
          if (raced) return raced
        }
        throw error
      }
    },
    async ensureChildRun(params) {
      await ready
      const { runId, nodeName, childKey } = params
      const loadExistingChildRun = async (
        connection: WorkflowPostgresConnection,
      ) => {
        const childRow = await loadChild(connection, runId, nodeName, childKey)
        if (!childRow) {
          throw new Error(
            `Missing node child [${childRef(runId, nodeName, childKey)}]`,
          )
        }
        const child = mapNodeChild(childRow)
        if (!child.childRunId) return undefined
        const runRow = await one(
          connection,
          'SELECT * FROM workflow_runs WHERE id = $1',
          [child.childRunId],
        )
        if (!runRow) {
          throw new Error(`Missing child run [${child.childRunId}]`)
        }
        const childRun = mapRun(runRow)
        if (
          childRun.kind !== params.childKind ||
          childRun.name !== params.childName ||
          !sameValue(childRun.input, params.input) ||
          !sameOptionalValue(childRun.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(
            `Conflicting child run [${childRef(runId, nodeName, childKey)}]`,
          )
        }
        return { child, childRun, created: false }
      }
      const existing = await loadExistingChildRun(db)
      if (existing) return existing

      // The link UPDATE requires child_run_id IS NULL, so losing a race to
      // another coordinator rolls back our freshly created run instead of
      // persisting a duplicate child run.
      const linkRaced = Symbol('child-run-link-raced')
      try {
        return await db.transaction(async (tx) => {
          const raced = await loadExistingChildRun(tx)
          if (raced) return raced

          const childRun = await createStoredRun(
            tx,
            {
              kind: params.childKind,
              name: params.childName,
              workflowName: params.childName,
              ...(params.childKind === 'task'
                ? { taskName: params.childName }
                : {}),
              input: params.input,
              parentRunId: runId,
              parentNodeName: nodeName,
              rootRunId: params.rootRunId,
              tags: params.tags,
              idempotencyKey: params.idempotencyKey,
            },
            { recoverUniqueViolation: false },
          )
          const updated = await one(
            tx,
            `
            WITH candidate AS (
              SELECT c.run_id, c.node_name, c.child_key,
                c.status::text AS old_status, r.root_run_id
              FROM workflow_node_children c
              JOIN workflow_runs r ON r.id = c.run_id
              WHERE c.run_id = $1 AND c.node_name = $2 AND c.child_key = $3
            ),
            updated AS (
            UPDATE workflow_node_children
            SET child_run_id = $4,
                status = 'running',
                version = version + 1,
                updated_at = now()
            FROM candidate
            WHERE workflow_node_children.run_id = candidate.run_id
              AND workflow_node_children.node_name = candidate.node_name
              AND workflow_node_children.child_key = candidate.child_key
              AND workflow_node_children.child_run_id IS NULL
              AND workflow_node_children.status IN (${nodeStatusSourcesSql('running', { self: true })})
            RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
            ),
            ${emitStatusChangeNotifySql('updated', 'child_run_linked')}
            SELECT updated.*${notifyRunStatusEventColumnsSql('child_run_linked')}
            FROM updated
          `,
            [runId, nodeName, childKey, childRun.id],
          )
          if (!updated) throw linkRaced
          return { child: mapNodeChild(updated), childRun, created: true }
        })
      } catch (error) {
        if (
          error === linkRaced ||
          error instanceof WorkflowRunInsertConflict ||
          isUniqueViolation(error)
        ) {
          const raced = await loadExistingChildRun(db)
          if (raced) return raced
          throw new Error(
            `Terminal node child [${childRef(runId, nodeName, childKey)}] cannot start child run`,
          )
        }
        throw error
      }
    },
    async ensureChildAttempt({
      runId,
      nodeName,
      childKey,
      input,
      idempotencyKey,
    }) {
      await ready
      try {
        return await db.transaction(async (tx) => {
          const childRow = await loadChild(tx, runId, nodeName, childKey)
          if (!childRow) {
            throw new Error(
              `Missing node child [${childRef(runId, nodeName, childKey)}]`,
            )
          }
          const child = mapNodeChild(childRow)
          if (child.attemptCount > 0) {
            const current = child.currentAttemptId
              ? await one(tx, 'SELECT * FROM workflow_attempts WHERE id = $1', [
                  child.currentAttemptId,
                ])
              : await loadLatestChildAttempt(tx, runId, nodeName, childKey)
            if (!current) {
              throw new Error(
                `Missing attempt for node child [${childRef(runId, nodeName, childKey)}]`,
              )
            }
            return { attempt: mapAttempt(current), created: false }
          }
          if (isTerminalNodeStatus(child.status)) {
            throw new Error(
              `Terminal node child [${childRef(runId, nodeName, childKey)}] cannot create attempt`,
            )
          }

          const attemptId = id()
          const leaseToken = id()
          const attempt = await one(
            tx,
            `
            WITH inserted AS (
            INSERT INTO workflow_attempts (
              id, run_id, node_name, child_key, status,
              lease_token, attempt_number, input, idempotency_key, dispatched_at
            )
            VALUES ($1, $2, $3, $4, 'started', $5, 1, $6::jsonb, $7::jsonb, now())
            RETURNING *, NULL::text AS old_status
            ),
            event_source AS (
              SELECT inserted.*, r.root_run_id
              FROM inserted
              JOIN workflow_runs r ON r.id = inserted.run_id
            ),
            ${emitStatusChangeNotifySql('event_source', 'attempt_started')}
            SELECT inserted.*${notifyRunStatusEventColumnsSql('attempt_started')}
            FROM inserted
          `,
            [
              attemptId,
              runId,
              nodeName,
              childKey,
              leaseToken,
              json(input),
              idempotencyKey ? json(idempotencyKey) : null,
            ],
          )
          const updatedChild = await one(
            tx,
            `
            WITH candidate AS (
              SELECT c.run_id, c.node_name, c.child_key,
                c.status::text AS old_status, r.root_run_id
              FROM workflow_node_children c
              JOIN workflow_runs r ON r.id = c.run_id
              WHERE c.run_id = $1 AND c.node_name = $2 AND c.child_key = $3
            ),
            updated AS (
            UPDATE workflow_node_children
            SET current_attempt_id = $4,
                attempt_count = 1,
                status = 'running',
                version = version + 1,
                updated_at = now()
            FROM candidate
            WHERE workflow_node_children.run_id = candidate.run_id
              AND workflow_node_children.node_name = candidate.node_name
              AND workflow_node_children.child_key = candidate.child_key
              AND workflow_node_children.status IN (${nodeStatusSourcesSql('running', { self: true })})
            RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
            ),
            ${emitStatusChangeNotifySql('updated', 'child_running')}
            SELECT updated.*${notifyRunStatusEventColumnsSql('child_running')}
            FROM updated
          `,
            [runId, nodeName, childKey, attemptId],
          )
          if (!updatedChild) {
            throw new Error(
              `Terminal node child [${childRef(runId, nodeName, childKey)}] cannot create attempt`,
            )
          }
          // Aggregate hint only: a child attempt implies node activity, but a
          // node parked in another state must not fail the attempt creation.
          await tx.query(
            `
            WITH candidate AS (
              SELECT n.run_id, n.name, n.status::text AS old_status, r.root_run_id
              FROM workflow_nodes n
              JOIN workflow_runs r ON r.id = n.run_id
              WHERE n.run_id = $1 AND n.name = $2
            ),
            updated AS (
            UPDATE workflow_nodes
            SET status = 'running', version = version + 1, updated_at = now()
            FROM candidate
            WHERE workflow_nodes.run_id = candidate.run_id
              AND workflow_nodes.name = candidate.name
              AND workflow_nodes.status IN (${nodeStatusSourcesSql('running', { self: true })})
            RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
            ),
            ${emitStatusChangeNotifySql('updated', 'node_running')}
            SELECT count(*)${notifyRunStatusEventColumnsSql('node_running')}
            FROM updated
          `,
            [runId, nodeName],
          )
          return { attempt: mapAttempt(attempt!), created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadLatestChildAttempt(
            db,
            runId,
            nodeName,
            childKey,
          )
          if (raced) return { attempt: mapAttempt(raced), created: false }
        }
        throw error
      }
    },
    async selectNodeCase({ runId, nodeName, caseKey }) {
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
      if (node.selected_case === caseKey) return mapNode(node)
      if (node.selected_case !== null) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }
      const row = await one(
        db,
        `
        UPDATE workflow_nodes
        SET selected_case = $3, version = version + 1, updated_at = now()
        WHERE run_id = $1 AND name = $2
          AND status NOT IN ('completed', 'failed', 'cancelled')
          AND selected_case IS NULL
        RETURNING *
      `,
        [runId, nodeName, caseKey],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!current) return undefined
      if (isTerminalNodeStatus(current.status as StoredNode['status'])) {
        return mapNode(current)
      }
      if (current.selected_case === caseKey) return mapNode(current)
      throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
    },
    async completeNodeChild({ runId, nodeName, childKey, output }) {
      await ready
      const childRow = await loadChild(db, runId, nodeName, childKey)
      if (!childRow) return undefined
      if (isTerminalNodeStatus(childRow.status as StoredNodeChild['status'])) {
        return mapNodeChild(childRow)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT c.run_id, c.node_name, c.child_key,
            c.status::text AS old_status, r.root_run_id
          FROM workflow_node_children c
          JOIN workflow_runs r ON r.id = c.run_id
          WHERE c.run_id = $1 AND c.node_name = $2 AND c.child_key = $3
        ),
        updated AS (
        UPDATE workflow_node_children
        SET status = 'completed',
            output = $4::jsonb,
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
        [runId, nodeName, childKey, json(output)],
      )
      if (row) return mapNodeChild(row)
      const current = await loadChild(db, runId, nodeName, childKey)
      return current ? mapNodeChild(current) : undefined
    },
    async failNodeChild({ runId, nodeName, childKey, error }) {
      await ready
      const childRow = await loadChild(db, runId, nodeName, childKey)
      if (!childRow) return undefined
      if (isTerminalNodeStatus(childRow.status as StoredNodeChild['status'])) {
        return mapNodeChild(childRow)
      }
      const row = await one(
        db,
        `
        WITH candidate AS (
          SELECT c.run_id, c.node_name, c.child_key,
            c.status::text AS old_status, r.root_run_id
          FROM workflow_node_children c
          JOIN workflow_runs r ON r.id = c.run_id
          WHERE c.run_id = $1 AND c.node_name = $2 AND c.child_key = $3
        ),
        updated AS (
        UPDATE workflow_node_children
        SET status = 'failed',
            error = $4::jsonb,
            version = version + 1,
            updated_at = now()
        FROM candidate
        WHERE workflow_node_children.run_id = candidate.run_id
          AND workflow_node_children.node_name = candidate.node_name
          AND workflow_node_children.child_key = candidate.child_key
          AND workflow_node_children.status IN (${nodeStatusSourcesSql('failed')})
        RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'child_failed')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('child_failed')}
        FROM updated
      `,
        [runId, nodeName, childKey, json(toStoredError(error))],
      )
      if (row) return mapNodeChild(row)
      const current = await loadChild(db, runId, nodeName, childKey)
      return current ? mapNodeChild(current) : undefined
    },
    async waitNode({ runId, nodeName }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
        node.status === 'waiting'
      ) {
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
        SET status = 'waiting', version = version + 1, updated_at = now()
        FROM candidate
        WHERE workflow_nodes.run_id = candidate.run_id
          AND workflow_nodes.name = candidate.name
          AND workflow_nodes.status IN (${nodeStatusSourcesSql('waiting', { self: true })})
        RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
        ),
        ${emitStatusChangeNotifySql('updated', 'node_waiting')}
        SELECT updated.*${notifyRunStatusEventColumnsSql('node_waiting')}
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
    async loadNodeChildren({ runId, nodeName }) {
      await ready
      const [children, attempts] = await Promise.all([
        loadOrderedChildren(db, runId, nodeName),
        many(
          db,
          'SELECT * FROM workflow_attempts WHERE run_id = $1 AND node_name = $2',
          [runId, nodeName],
        ),
      ])
      return {
        children: children.map(mapNodeChild),
        attempts: attempts.map(mapAttempt),
      }
    },
  }

  return childStore
}
