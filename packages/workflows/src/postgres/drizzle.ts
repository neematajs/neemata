import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { ACTIVE, PENDING } from './records.ts'

/**
 * Schema generation 6 as Drizzle objects, for applications that keep their
 * migrations with Drizzle. For the schema only: the adapter itself speaks
 * SQL through `SqlClient`. Object names are fixed.
 */

const at = (name: string) => timestamp(name, { withTimezone: true })

export type CreateSchemaOptions = {
  /**
   * GIN indexes over `workflow_runs.tags` and `input`, for lists of runs
   * that filter by them: `workflow_runs_tags_gin_idx` serves the `tags`
   * filter and `workflow_runs_input_gin_idx` the `input` filter, both of
   * which are containment (`@>`). Off by default: they cost every write of
   * a run, and most deployments never filter by whole payloads. The adapter
   * needs neither, and `verify` asks for neither.
   */
  readonly searchIndexes?: boolean
}

export function createSchema(options: CreateSchemaOptions = {}) {
  const { searchIndexes = false } = options
  const enums = {
    runKind: pgEnum('workflow_run_kind', ['workflow', 'task']),
    nodeKind: pgEnum('workflow_node_kind', [
      'activity',
      'task',
      'workflow',
      'branch',
      'parallel',
      'mapTask',
      'mapWorkflow',
      'sleep',
      'now',
      'input',
    ]),
    nodeChildKind: pgEnum('workflow_node_child_kind', [
      'activity',
      'task',
      'workflow',
    ]),
    runStatus: pgEnum('workflow_run_status', [
      'queued',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'failed',
      'completed',
      'blocked',
    ]),
    nodeStatus: pgEnum('workflow_node_status', [
      'pending',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'failed',
      'completed',
    ]),
    attemptStatus: pgEnum('workflow_attempt_status', [
      'started',
      'completed',
      'failed',
      'timedOut',
      'cancelled',
    ]),
  }

  const schemaVersion = pgTable(
    'workflow_schema_version',
    {
      id: integer('id').primaryKey().default(1),
      version: integer('version').notNull(),
      installedAt: at('installed_at').notNull().defaultNow(),
    },
    (t) => [check('workflow_schema_version_singleton_chk', sql`${t.id} = 1`)],
  )

  // Shared by every run that names them, and never deleted with one.
  const definitions = pgTable('workflow_definitions', {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  })

  const nodes = pgTable(
    'workflow_nodes',
    {
      runId: uuid('run_id').notNull(),
      name: text('name').notNull(),
      kind: enums.nodeKind('kind').notNull(),
      status: enums.nodeStatus('status').notNull(),
      input: jsonb('input'),
      output: jsonb('output'),
      error: jsonb('error'),
      selectedCase: text('selected_case'),
      operation: jsonb('operation'),
      version: integer('version').notNull(),
      createdAt: at('created_at').notNull(),
      updatedAt: at('updated_at').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.runId, t.name] }),
      foreignKey({
        name: 'workflow_nodes_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )

  const runs = pgTable(
    'workflow_runs',
    {
      id: uuid('id').primaryKey(),
      kind: enums.runKind('kind').notNull(),
      name: text('name').notNull(),
      status: enums.runStatus('status').notNull(),
      input: jsonb('input'),
      output: jsonb('output'),
      error: jsonb('error'),
      parentRunId: uuid('parent_run_id'),
      parentNodeName: text('parent_node_name'),
      parentRouteName: text('parent_route_name'),
      parentRouteRevision: text('parent_route_revision'),
      rootRunId: uuid('root_run_id').notNull(),
      tags: jsonb('tags').notNull().default({}),
      idempotencyKey: jsonb('idempotency_key'),
      uniqueKey: jsonb('unique_key'),
      uniqueScope: text('unique_scope'),
      uniqueBehavior: text('unique_behavior'),
      executionRevision: text('execution_revision'),
      graphHash: text('graph_hash'),
      graphPresentation: jsonb('graph_presentation'),
      version: integer('version').notNull(),
      activeSince: at('active_since').notNull().defaultNow(),
      createdAt: at('created_at').notNull(),
      updatedAt: at('updated_at').notNull(),
    },
    (t) => [
      index('workflow_runs_parent_idx')
        .on(t.parentRunId)
        .where(sql.raw('parent_run_id IS NOT NULL')),
      index('workflow_runs_root_idx').on(t.rootRunId),
      index('workflow_runs_prune_idx')
        .on(t.status, t.updatedAt)
        .where(sql.raw('parent_run_id IS NULL')),
      index('workflow_runs_created_idx').on(t.createdAt, t.id),
      ...(searchIndexes
        ? [
            index('workflow_runs_input_gin_idx').using(
              'gin',
              t.input.op('jsonb_path_ops'),
            ),
            index('workflow_runs_tags_gin_idx').using(
              'gin',
              t.tags.op('jsonb_path_ops'),
            ),
          ]
        : []),
      foreignKey({
        name: 'workflow_runs_parent_run_fk',
        columns: [t.parentRunId],
        foreignColumns: [t.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'workflow_runs_root_run_fk',
        columns: [t.rootRunId],
        foreignColumns: [t.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'workflow_runs_parent_node_fk',
        columns: [t.parentRunId, t.parentNodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
    ],
  )

  const attempts = pgTable(
    'workflow_attempts',
    {
      id: uuid('id').primaryKey(),
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      childKey: text('child_key').notNull(),
      status: enums.attemptStatus('status').notNull(),
      attemptNumber: integer('attempt_number').notNull(),
      retryAttemptNumber: integer('retry_attempt_number').notNull(),
      input: jsonb('input'),
      output: jsonb('output'),
      error: jsonb('error'),
      dispatchedAt: at('dispatched_at').notNull(),
      completedAt: at('completed_at'),
    },
    (t) => [
      unique('workflow_attempts_child_attempt_key').on(
        t.runId,
        t.nodeName,
        t.childKey,
        t.attemptNumber,
      ),
      index('workflow_attempts_node_idx').on(t.runId, t.nodeName),
      foreignKey({
        name: 'workflow_attempts_node_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
    ],
  )

  const nodeChildren = pgTable(
    'workflow_node_children',
    {
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      childKey: text('child_key').notNull(),
      kind: enums.nodeChildKind('kind').notNull(),
      status: enums.nodeStatus('status').notNull(),
      ordinal: integer('ordinal'),
      item: jsonb('item'),
      input: jsonb('input'),
      output: jsonb('output'),
      error: jsonb('error'),
      childRunId: uuid('child_run_id'),
      cancellation: text('cancellation'),
      currentAttemptId: uuid('current_attempt_id'),
      attemptCount: integer('attempt_count').notNull().default(0),
      version: integer('version').notNull(),
      createdAt: at('created_at').notNull(),
      updatedAt: at('updated_at').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.runId, t.nodeName, t.childKey] }),
      index('workflow_node_children_node_idx').on(t.runId, t.nodeName),
      index('workflow_node_children_child_run_idx').on(t.childRunId),
      // A node's children by ordinal: a map's waiting, under way, and all.
      index('workflow_children_pending_ordinal_idx')
        .on(t.runId, t.nodeName, t.ordinal, t.childKey)
        .where(sql.raw(PENDING)),
      index('workflow_children_active_ordinal_idx')
        .on(t.runId, t.nodeName, t.ordinal, t.childKey)
        .where(sql.raw(ACTIVE)),
      index('workflow_children_ordinal_idx').on(
        t.runId,
        t.nodeName,
        t.ordinal,
        t.childKey,
      ),
      foreignKey({
        name: 'workflow_node_children_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'workflow_node_children_node_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
      foreignKey({
        name: 'workflow_node_children_child_run_fk',
        columns: [t.childRunId],
        foreignColumns: [runs.id],
      }).onDelete('set null'),
      foreignKey({
        name: 'workflow_node_children_current_attempt_fk',
        columns: [t.currentAttemptId],
        foreignColumns: [attempts.id],
      }).onDelete('set null'),
    ],
  )

  // Identity keys: which run holds each.
  const keys = pgTable(
    'workflow_keys',
    {
      key: text('key').primaryKey(),
      runId: uuid('run_id').notNull(),
    },
    (t) => [
      index('workflow_keys_run_idx').on(t.runId),
      foreignKey({
        name: 'workflow_keys_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )

  const commands = pgTable(
    'workflow_commands',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      kind: text('kind').notNull(),
      runId: uuid('run_id').notNull(),
      revision: text('revision'),
      payload: jsonb('payload').notNull(),
      runAt: at('run_at').notNull(),
      leaseToken: text('lease_token'),
      leaseExpiresAt: at('lease_expires_at'),
      deliveryCount: integer('delivery_count').notNull().default(0),
      lastError: jsonb('last_error'),
      deadAt: at('dead_at'),
      createdAt: at('created_at').notNull().defaultNow(),
      name: text('name').notNull(),
      dedupe: text('dedupe').notNull(),
      // The order commands were queued in, which is the order of delivery.
      seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity(),
    },
    (t) => [
      // A lane's commands in the order they were queued: a claim reads the
      // head of each lane it serves.
      index('workflow_commands_lane_idx')
        .on(t.kind, t.name, t.revision, t.seq, t.runAt)
        .where(sql.raw('dead_at IS NULL')),
      // The predicates are the dedupe rule: one command never claimed per
      // key, and any number of commands given back.
      uniqueIndex('workflow_commands_fresh_idx')
        .on(t.dedupe)
        .where(sql.raw('lease_token IS NULL AND dead_at IS NULL')),
      index('workflow_commands_released_idx')
        .on(t.dedupe)
        .where(
          sql.raw(
            'lease_token IS NOT NULL AND lease_expires_at IS NULL AND dead_at IS NULL',
          ),
        ),
      index('workflow_commands_dead_idx')
        .on(t.deadAt)
        .where(sql.raw('dead_at IS NOT NULL')),
      index('workflow_commands_run_idx').on(t.runId),
      foreignKey({
        name: 'workflow_commands_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )

  const schedules = pgTable(
    'workflow_schedules',
    {
      name: text('name').primaryKey(),
      runnableKind: enums.runKind('runnable_kind').notNull(),
      runnableName: text('runnable_name').notNull(),
      executionRevision: text('execution_revision'),
      graphHash: text('graph_hash'),
      graphPresentation: jsonb('graph_presentation'),
      input: jsonb('input'),
      tags: jsonb('tags').notNull().default({}),
      cron: text('cron'),
      timeZone: text('time_zone'),
      everyMs: bigint('every_ms', { mode: 'number' }),
      enabled: boolean('enabled').notNull(),
      nextRunAt: at('next_run_at').notNull(),
      lastSlotAt: at('last_slot_at'),
      version: integer('version').notNull(),
      createdAt: at('created_at').notNull(),
      updatedAt: at('updated_at').notNull(),
    },
    (t) => [
      index('workflow_schedules_due_idx')
        .on(t.nextRunAt)
        .where(sql.raw('enabled')),
    ],
  )

  return {
    enums,
    tables: {
      schemaVersion,
      definitions,
      runs,
      nodes,
      attempts,
      nodeChildren,
      keys,
      commands,
      schedules,
    },
  }
}

export type WorkflowSchema = ReturnType<typeof createSchema>
