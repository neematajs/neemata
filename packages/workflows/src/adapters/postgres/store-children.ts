import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { AttemptRow, ChildRow, NodeRow } from './rows.ts'
import { toStoredError } from '../../runtime/errors.ts'
import { isTerminalNodeStatus } from '../../runtime/status.ts'
import { sameOptionalValue, sameValue } from './compare.ts'
import { TERMINAL_NODE_STATUSES_SQL } from './fragments.ts'
import { isUniqueViolation, json, many, one } from './query.ts'
import {
  loadChild,
  loadNode,
  loadOrderedChildren,
  loadRun,
  mapAttempt,
  mapNode,
  mapNodeChild,
  mapRun,
} from './rows.ts'
import { createAttempt } from './store-nodes.ts'
import { insertRun, WorkflowRunInsertConflict } from './store-runs.ts'
import {
  transitionChild,
  transitionChildRow,
  transitionNode,
} from './transitions.ts'

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

const missingChild = (runId: string, nodeName: string, childKey: string) =>
  new Error(`Missing node child [${childRef(runId, nodeName, childKey)}]`)

const loadLatestChildAttempt = (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
  childKey: string,
) =>
  one<AttemptRow>(
    db,
    `
    SELECT *
    FROM workflow_attempts
    WHERE run_id = $1 AND node_name = $2 AND child_key = $3
    ORDER BY attempt_number DESC
    LIMIT 1
  `,
    [runId, nodeName, childKey],
  )

export const createPostgresWorkflowChildStore = (
  db: WorkflowPostgresConnection,
): PostgresWorkflowChildStore => ({
  async ensureNodeChildren({ runId, nodeName, children }) {
    const node = await loadNode(db, runId, nodeName)
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
    const { runId, nodeName, childKey } = params
    const loadExistingChildRun = async (
      connection: WorkflowPostgresConnection,
    ) => {
      const childRow = await loadChild(connection, runId, nodeName, childKey)
      if (!childRow) throw missingChild(runId, nodeName, childKey)
      const child = mapNodeChild(childRow)
      if (!child.childRunId) return undefined
      const runRow = await loadRun(connection, child.childRunId)
      if (!runRow) throw new Error(`Missing child run [${child.childRunId}]`)
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
      // Re-entry after the link committed but before the child started: no
      // status event is wanted, the link write already published one.
      if (child.status === 'pending') {
        const updated = await one<ChildRow>(
          connection,
          `
          UPDATE workflow_node_children
          SET status = 'running', version = version + 1, updated_at = now()
          WHERE run_id = $1 AND node_name = $2 AND child_key = $3
            AND status = 'pending'
          RETURNING *
        `,
          [runId, nodeName, childKey],
        )
        if (updated) {
          return { child: mapNodeChild(updated), childRun, created: false }
        }
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

        const { run: childRun } = await insertRun(
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
          { inlineRaceRecovery: false },
        )
        const updated = await transitionChildRow(
          tx,
          runId,
          nodeName,
          childKey,
          'running',
          {
            event: 'child_run_linked',
            self: true,
            set: 'child_run_id = $4',
            values: [childRun.id],
            where: 'AND workflow_node_children.child_run_id IS NULL',
          },
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
    try {
      return await db.transaction(async (tx) => {
        const childRow = await one<ChildRow>(
          tx,
          `
          SELECT *
          FROM workflow_node_children
          WHERE run_id = $1 AND node_name = $2 AND child_key = $3
          FOR UPDATE
        `,
          [runId, nodeName, childKey],
        )
        if (!childRow) throw missingChild(runId, nodeName, childKey)
        const child = mapNodeChild(childRow)
        if (child.attemptCount > 0) {
          const current = child.currentAttemptId
            ? await one<AttemptRow>(
                tx,
                'SELECT * FROM workflow_attempts WHERE id = $1',
                [child.currentAttemptId],
              )
            : await loadLatestChildAttempt(tx, runId, nodeName, childKey)
          if (!current) {
            throw new Error(
              `Missing attempt for node child [${childRef(runId, nodeName, childKey)}]`,
            )
          }
          if (
            child.status === 'pending' &&
            child.currentAttemptId === undefined
          ) {
            const previous = mapAttempt(current)
            const attempt = await createAttempt(tx, {
              runId,
              nodeName,
              childKey,
              input: previous.input,
              idempotencyKey: previous.idempotencyKey,
            })
            return { attempt, created: true }
          }
          return { attempt: mapAttempt(current), created: false }
        }
        if (isTerminalNodeStatus(child.status)) {
          throw new Error(
            `Terminal node child [${childRef(runId, nodeName, childKey)}] cannot create attempt`,
          )
        }

        const attempt = await createAttempt(tx, {
          runId,
          nodeName,
          childKey,
          input,
          idempotencyKey,
        })
        return { attempt, created: true }
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
    // A node that is terminal or already carries the case is settled; any
    // other stored case is a definition conflict.
    const resolve = (row: NodeRow) => {
      if (isTerminalNodeStatus(row.status)) return mapNode(row)
      if (row.selected_case === caseKey) return mapNode(row)
      if (row.selected_case !== null) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }
      return undefined
    }

    const node = await loadNode(db, runId, nodeName)
    if (!node) return undefined
    const settled = resolve(node)
    if (settled) return settled

    const row = await one<NodeRow>(
      db,
      `
      UPDATE workflow_nodes
      SET selected_case = $3, version = version + 1, updated_at = now()
      WHERE run_id = $1 AND name = $2
        AND status NOT IN (${TERMINAL_NODE_STATUSES_SQL})
        AND selected_case IS NULL
      RETURNING *
    `,
      [runId, nodeName, caseKey],
    )
    if (row) return mapNode(row)
    const current = await loadNode(db, runId, nodeName)
    if (!current) return undefined
    const raced = resolve(current)
    if (raced) return raced
    throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
  },
  async completeNodeChild({ runId, nodeName, childKey, output }) {
    const childRow = await loadChild(db, runId, nodeName, childKey)
    if (!childRow) return undefined
    if (isTerminalNodeStatus(childRow.status)) return mapNodeChild(childRow)
    return transitionChild(db, runId, nodeName, childKey, 'completed', {
      set: 'output = $4::jsonb',
      values: [json(output)],
    })
  },
  async failNodeChild({ runId, nodeName, childKey, error }) {
    const childRow = await loadChild(db, runId, nodeName, childKey)
    if (!childRow) return undefined
    if (isTerminalNodeStatus(childRow.status)) return mapNodeChild(childRow)
    return transitionChild(db, runId, nodeName, childKey, 'failed', {
      set: 'error = $4::jsonb',
      values: [json(toStoredError(error))],
    })
  },
  async waitNode({ runId, nodeName }) {
    const node = await loadNode(db, runId, nodeName)
    if (!node) return undefined
    if (isTerminalNodeStatus(node.status) || node.status === 'waiting') {
      return mapNode(node)
    }
    return transitionNode(db, runId, nodeName, 'waiting', { self: true })
  },
  async loadNodeChildren({ runId, nodeName }) {
    const [children, attempts] = await Promise.all([
      loadOrderedChildren(db, runId, nodeName),
      many<AttemptRow>(
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
})
