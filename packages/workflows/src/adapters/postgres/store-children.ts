import type {
  NodeChildIdentity,
  StoredNode,
  StoredRun,
} from '../../runtime/state.ts'
import type { CreateRunInput, WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { toStoredError } from '../../runtime/errors.ts'
import { isTerminalNodeStatus } from '../../runtime/status.ts'
import {
  id,
  identityKey,
  isUniqueViolation,
  json,
  many,
  mapAttempt,
  mapChildLink,
  mapMapItem,
  mapNode,
  mapRun,
  one,
  sameOptionalValue,
  sameValue,
} from './sql.ts'

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
  | 'ensureNodeAttempt'
  | 'ensureChildRun'
  | 'ensureChildWorkflowRun'
  | 'selectNodeCase'
  | 'ensureMapItems'
  | 'completeMapItem'
  | 'failMapItem'
  | 'waitNode'
  | 'loadNodeChildren'
>

export const createPostgresWorkflowChildStore = (
  ctx: PostgresWorkflowChildStoreContext,
): PostgresWorkflowChildStore => {
  const { db, ready, createStoredRun } = ctx

  const childStore: PostgresWorkflowChildStore = {
    async ensureNodeAttempt(params) {
      await ready
      const key = identityKey(params.identity)
      try {
        return await db.transaction(async (tx) => {
          const node = await one(
            tx,
            'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
            [params.identity.runId, params.identity.nodeName],
          )
          if (!node) {
            throw new Error(
              `Missing node [${params.identity.runId}.${params.identity.nodeName}]`,
            )
          }
          if (
            (node.kind === 'activity' || node.kind === 'task') &&
            node.kind !== params.kind
          ) {
            throw new Error(
              `Node [${String(node.run_id)}.${String(node.name)}] kind [${String(node.kind)}] cannot create [${params.kind}] attempt`,
            )
          }

          const existing = await one(
            tx,
            'SELECT * FROM workflow_attempts WHERE identity_key = $1',
            [key],
          )
          if (existing) {
            return { attempt: mapAttempt(existing), created: false }
          }

          const attemptId = id()
          const leaseToken = id()
          const attempt = await one(
            tx,
            `
            INSERT INTO workflow_attempts (
              id, run_id, node_name, identity_key, identity, status,
              lease_token, attempt_number, input, idempotency_key, dispatched_at
            )
            VALUES (
              $1, $2, $3, $4, $5::jsonb, 'started',
              $6, $7, $8::jsonb, $9::jsonb, now()
            )
            RETURNING *
          `,
            [
              attemptId,
              params.identity.runId,
              params.identity.nodeName,
              key,
              json(params.identity),
              leaseToken,
              (node.attempt_count as number) + 1,
              json(params.input),
              params.idempotencyKey ? json(params.idempotencyKey) : null,
            ],
          )
          const updatedNode = await one(
            tx,
            `
            UPDATE workflow_nodes
            SET status = 'waiting',
                current_attempt_id = $3,
                attempt_count = attempt_count + 1,
                version = version + 1,
                updated_at = now()
            WHERE run_id = $1 AND name = $2
              AND status NOT IN ('completed', 'failed', 'cancelled')
            RETURNING *
          `,
            [params.identity.runId, params.identity.nodeName, attemptId],
          )
          if (!updatedNode) {
            throw new Error(
              `Terminal node [${params.identity.runId}.${params.identity.nodeName}] cannot create attempt`,
            )
          }
          return { attempt: mapAttempt(attempt!), created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await one(
            db,
            'SELECT * FROM workflow_attempts WHERE identity_key = $1',
            [key],
          )
          if (raced) return { attempt: mapAttempt(raced), created: false }
        }
        throw error
      }
    },
    async ensureChildRun(params) {
      await ready
      if (
        params.identity.runId !== params.parentRunId ||
        params.identity.nodeName !== params.parentNodeName
      ) {
        throw new Error(
          `Child identity does not match parent node [${params.parentRunId}.${params.parentNodeName}]`,
        )
      }

      const key = identityKey(params.identity)
      const loadExistingChildRun = async (
        connection: WorkflowPostgresConnection,
      ) => {
        const existingLink = await one(
          connection,
          'SELECT * FROM workflow_child_links WHERE identity_key = $1',
          [key],
        )
        if (!existingLink) return undefined
        const childRun = await one(
          connection,
          'SELECT * FROM workflow_runs WHERE id = $1',
          [existingLink.child_run_id],
        )
        if (!childRun) {
          throw new Error(
            `Missing child run [${String(existingLink.child_run_id)}]`,
          )
        }
        const link = mapChildLink(existingLink)
        const run = mapRun(childRun)
        if (
          link.childKind !== params.childKind ||
          link.childName !== params.childName ||
          run.kind !== params.childKind ||
          run.name !== params.childName ||
          !sameValue(run.input, params.input) ||
          !sameOptionalValue(run.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(
            `Conflicting child run [${params.parentRunId}.${params.parentNodeName}]`,
          )
        }
        return { childLink: link, childRun: run, created: false }
      }
      const existing = await loadExistingChildRun(db)
      if (existing) return existing

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
              parentRunId: params.parentRunId,
              parentNodeName: params.parentNodeName,
              rootRunId: params.rootRunId,
              tags: params.tags,
              idempotencyKey: params.idempotencyKey,
            },
            { recoverUniqueViolation: false },
          )
          const link = await one(
            tx,
            `
            INSERT INTO workflow_child_links (
              identity_key, identity, parent_run_id, parent_node_name,
              child_run_id, child_kind, child_name, workflow_name, task_name,
              case_key, member_key, item_index, item_key
            )
            VALUES (
              $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
            )
            RETURNING *
          `,
            [
              key,
              json(params.identity),
              params.parentRunId,
              params.parentNodeName,
              childRun.id,
              params.childKind,
              params.childName,
              params.childName,
              params.childKind === 'task' ? params.childName : null,
              params.identity.caseKey ?? null,
              params.identity.memberKey ?? null,
              params.identity.itemIndex ?? null,
              params.identity.itemKey ?? null,
            ],
          )
          return { childLink: mapChildLink(link!), childRun, created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadExistingChildRun(db)
          if (raced) return raced
        }
        throw error
      }
    },
    async ensureChildWorkflowRun(params) {
      return childStore.ensureChildRun({
        identity: params.identity,
        childKind: 'workflow',
        childName: params.workflowName,
        input: params.input,
        parentRunId: params.parentRunId,
        parentNodeName: params.parentNodeName,
        rootRunId: params.rootRunId,
        tags: params.tags,
        idempotencyKey: params.idempotencyKey,
      })
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
    async ensureMapItems(params) {
      await ready
      const key = `${params.runId}:${params.nodeName}`
      if (params.keys && params.keys.length !== params.items.length) {
        throw new Error(`Conflicting map items for [${key}]`)
      }
      const keys = params.items.map((_, index) => params.keys?.[index])
      const definedKeys = keys.filter((itemKey) => itemKey !== undefined)
      if (new Set(definedKeys).size !== definedKeys.length) {
        throw new Error(`Duplicate map item key for [${key}]`)
      }

      const loadExistingMapItems = async (
        connection: WorkflowPostgresConnection,
      ) => {
        const existingSet = await one(
          connection,
          `
          SELECT *
          FROM workflow_map_item_sets
          WHERE run_id = $1 AND node_name = $2
        `,
          [params.runId, params.nodeName],
        )
        const existingItems = await many(
          connection,
          `
          SELECT *
          FROM workflow_map_items
          WHERE run_id = $1 AND node_name = $2
          ORDER BY item_index ASC
        `,
          [params.runId, params.nodeName],
        )
        if (!existingSet) return undefined
        const existingKeys = existingSet.keys as readonly (
          | string
          | null
          | undefined
        )[]
        const sameKeys =
          existingKeys.length === keys.length &&
          existingKeys.every(
            (existingKey, index) =>
              (existingKey ?? null) === (keys[index] ?? null),
          )
        if (!sameKeys) throw new Error(`Conflicting map items for [${key}]`)
        const sameItems =
          existingItems.length === params.items.length &&
          existingItems.every((existingItem, index) =>
            sameValue(existingItem.item, params.items[index]),
          )
        if (!sameItems) throw new Error(`Conflicting map items for [${key}]`)
        return { items: existingItems.map(mapMapItem), created: false }
      }
      const existing = await loadExistingMapItems(db)
      if (existing) return existing

      try {
        return await db.transaction(async (tx) => {
          const raced = await loadExistingMapItems(tx)
          if (raced) return raced

          await tx.query(
            `
            INSERT INTO workflow_map_item_sets (run_id, node_name, keys)
            VALUES ($1, $2, $3::jsonb)
          `,
            [params.runId, params.nodeName, json(keys)],
          )
          for (const [index, item] of params.items.entries()) {
            const itemKey = params.keys?.[index]
            const identity: NodeChildIdentity = {
              runId: params.runId,
              nodeName: params.nodeName,
              itemIndex: index,
              ...(itemKey === undefined ? {} : { itemKey }),
            }
            await tx.query(
              `
              INSERT INTO workflow_map_items (
                run_id, node_name, item_index, identity_key, identity,
                item_key, item, status
              )
              VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, 'pending')
            `,
              [
                params.runId,
                params.nodeName,
                index,
                identityKey(identity),
                json(identity),
                itemKey ?? null,
                json(item),
              ],
            )
          }
          const created = await many(
            tx,
            `
            SELECT *
            FROM workflow_map_items
            WHERE run_id = $1 AND node_name = $2
            ORDER BY item_index ASC
          `,
            [params.runId, params.nodeName],
          )
          return { items: created.map(mapMapItem), created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadExistingMapItems(db)
          if (raced) return raced
        }
        throw error
      }
    },
    async completeMapItem(params) {
      await ready
      const row = await one(
        db,
        `
        UPDATE workflow_map_items
        SET status = 'completed', output = $5::jsonb
        WHERE run_id = $1 AND node_name = $2 AND item_index = $3
          AND item_key IS NOT DISTINCT FROM $4
          AND status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING *
      `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
          json(params.output),
        ],
      )
      if (row) return mapMapItem(row)
      const current = await one(
        db,
        `
        SELECT *
        FROM workflow_map_items
        WHERE run_id = $1 AND node_name = $2 AND item_index = $3
          AND item_key IS NOT DISTINCT FROM $4
      `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
        ],
      )
      return current ? mapMapItem(current) : undefined
    },
    async failMapItem(params) {
      await ready
      const row = await one(
        db,
        `
        UPDATE workflow_map_items
        SET status = 'failed', error = $5::jsonb
        WHERE run_id = $1 AND node_name = $2 AND item_index = $3
          AND item_key IS NOT DISTINCT FROM $4
          AND status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING *
      `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
          json(toStoredError(params.error)),
        ],
      )
      if (row) return mapMapItem(row)
      const current = await one(
        db,
        `
        SELECT *
        FROM workflow_map_items
        WHERE run_id = $1 AND node_name = $2 AND item_index = $3
          AND item_key IS NOT DISTINCT FROM $4
      `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
        ],
      )
      return current ? mapMapItem(current) : undefined
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
        UPDATE workflow_nodes
        SET status = 'waiting', version = version + 1, updated_at = now()
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
    async loadNodeChildren({ runId, nodeName }) {
      await ready
      const [attempts, childLinks, mapItems] = await Promise.all([
        many(
          db,
          'SELECT * FROM workflow_attempts WHERE run_id = $1 AND node_name = $2',
          [runId, nodeName],
        ),
        many(
          db,
          `
          SELECT *
          FROM workflow_child_links
          WHERE parent_run_id = $1 AND parent_node_name = $2
        `,
          [runId, nodeName],
        ),
        many(
          db,
          'SELECT * FROM workflow_map_items WHERE run_id = $1 AND node_name = $2',
          [runId, nodeName],
        ),
      ])
      return {
        attempts: attempts.map(mapAttempt),
        childLinks: childLinks.map(mapChildLink),
        mapItems: mapItems.map(mapMapItem),
      }
    },
  }

  return childStore
}
