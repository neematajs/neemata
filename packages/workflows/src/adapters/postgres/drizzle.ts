import { sql } from 'drizzle-orm'
import {
  check,
  bigint,
  boolean,
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

type TableKey =
  | 'schemaVersion'
  | 'schedules'
  | 'runs'
  | 'nodes'
  | 'attempts'
  | 'nodeChildren'
  | 'runLeases'
  | 'commands'

type EnumKey =
  | 'runKind'
  | 'nodeKind'
  | 'nodeChildKind'
  | 'runStatus'
  | 'nodeStatus'
  | 'attemptStatus'
  | 'commandKind'

const runKindValues = ['workflow', 'task'] as const
const nodeKindValues = [
  'activity',
  'task',
  'workflow',
  'branch',
  'parallel',
  'mapTask',
  'mapWorkflow',
] as const
const nodeChildKindValues = ['activity', 'task', 'workflow'] as const
const runStatusValues = [
  'queued',
  'running',
  'waiting',
  'cancelling',
  'cancelled',
  'failed',
  'completed',
] as const
const nodeStatusValues = [
  'pending',
  'running',
  'waiting',
  'cancelling',
  'cancelled',
  'failed',
  'completed',
] as const
const attemptStatusValues = [
  'started',
  'completed',
  'failed',
  'timedOut',
  'cancelled',
] as const
const commandKindValues = ['continue', 'activity', 'task'] as const

const tableNames = {
  schemaVersion: 'workflow_schema_version',
  schedules: 'workflow_schedules',
  runs: 'workflow_runs',
  nodes: 'workflow_nodes',
  attempts: 'workflow_attempts',
  nodeChildren: 'workflow_node_children',
  runLeases: 'workflow_run_leases',
  commands: 'workflow_commands',
} as const satisfies Record<TableKey, string>

const enumNames = {
  runKind: 'workflow_run_kind',
  nodeKind: 'workflow_node_kind',
  nodeChildKind: 'workflow_node_child_kind',
  runStatus: 'workflow_run_status',
  nodeStatus: 'workflow_node_status',
  attemptStatus: 'workflow_attempt_status',
  commandKind: 'workflow_command_kind',
} as const satisfies Record<EnumKey, string>

function createEnums() {
  return {
    runKind: pgEnum(enumNames.runKind, runKindValues),
    nodeKind: pgEnum(enumNames.nodeKind, nodeKindValues),
    nodeChildKind: pgEnum(enumNames.nodeChildKind, nodeChildKindValues),
    runStatus: pgEnum(enumNames.runStatus, runStatusValues),
    nodeStatus: pgEnum(enumNames.nodeStatus, nodeStatusValues),
    attemptStatus: pgEnum(enumNames.attemptStatus, attemptStatusValues),
    commandKind: pgEnum(enumNames.commandKind, commandKindValues),
  }
}

export function createSchema() {
  const enums = createEnums()
  const createTable = pgTable

  const schemaVersion = createTable(
    tableNames.schemaVersion,
    {
      id: integer('id').primaryKey().default(1),
      version: integer('version').notNull(),
      installedAt: timestamp('installed_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (t) => [check('workflow_schema_version_singleton_chk', sql`${t.id} = 1`)],
  )
  const runs = createTable(
    tableNames.runs,
    {
      id: uuid('id').primaryKey(),
      kind: enums.runKind('kind').notNull(),
      name: text('name').notNull(),
      workflowName: text('workflow_name').notNull(),
      taskName: text('task_name'),
      status: enums.runStatus('status').notNull(),
      input: jsonb('input').notNull(),
      output: jsonb('output'),
      error: jsonb('error'),
      parentRunId: uuid('parent_run_id'),
      parentNodeName: text('parent_node_name'),
      rootRunId: uuid('root_run_id').notNull(),
      tags: jsonb('tags').notNull().default({}),
      idempotencyKey: jsonb('idempotency_key'),
      version: integer('version').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('workflow_runs_idempotency_idx')
        .on(t.idempotencyKey)
        .where(sql.raw('idempotency_key IS NOT NULL')),
      index('workflow_runs_parent_idx')
        .on(t.parentRunId)
        .where(sql.raw('parent_run_id IS NOT NULL')),
      index('workflow_runs_root_idx').on(t.rootRunId),
      index('workflow_runs_input_gin_idx').using(
        'gin',
        t.input.op('jsonb_path_ops'),
      ),
      index('workflow_runs_tags_gin_idx').using(
        'gin',
        t.tags.op('jsonb_path_ops'),
      ),
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
  const schedules = createTable(
    tableNames.schedules,
    {
      id: uuid('id').primaryKey(),
      name: text('name').notNull(),
      runnableKind: enums.runKind('runnable_kind').notNull(),
      runnableName: text('runnable_name').notNull(),
      input: jsonb('input').notNull(),
      tags: jsonb('tags').notNull().default({}),
      cron: text('cron'),
      everyMs: bigint('every_ms', { mode: 'number' }),
      enabled: boolean('enabled').notNull(),
      nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
      lastSlotAt: timestamp('last_slot_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (t) => [
      unique('workflow_schedules_name_key').on(t.name),
      index('workflow_schedules_due_idx').on(t.enabled, t.nextRunAt),
      check(
        'workflow_schedules_cadence_chk',
        sql`(${t.cron} IS NULL) <> (${t.everyMs} IS NULL)`,
      ),
    ],
  )
  const nodes = createTable(
    tableNames.nodes,
    {
      runId: uuid('run_id').notNull(),
      name: text('name').notNull(),
      kind: enums.nodeKind('kind').notNull(),
      status: enums.nodeStatus('status').notNull(),
      input: jsonb('input'),
      output: jsonb('output'),
      error: jsonb('error'),
      selectedCase: text('selected_case'),
      version: integer('version').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({ name: 'workflow_nodes_pkey', columns: [t.runId, t.name] }),
      foreignKey({
        name: 'workflow_nodes_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )
  const attempts = createTable(
    tableNames.attempts,
    {
      id: uuid('id').primaryKey(),
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      childKey: text('child_key').notNull(),
      status: enums.attemptStatus('status').notNull(),
      workerId: text('worker_id'),
      leaseToken: text('lease_token'),
      attemptNumber: integer('attempt_number').notNull(),
      input: jsonb('input').notNull(),
      idempotencyKey: jsonb('idempotency_key'),
      output: jsonb('output'),
      error: jsonb('error'),
      dispatchedAt: timestamp('dispatched_at', {
        withTimezone: true,
      }).notNull(),
      heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
      completedAt: timestamp('completed_at', { withTimezone: true }),
    },
    (t) => [
      index('workflow_attempts_node_idx').on(t.runId, t.nodeName),
      unique('workflow_attempts_child_attempt_key').on(
        t.runId,
        t.nodeName,
        t.childKey,
        t.attemptNumber,
      ),
      foreignKey({
        name: 'workflow_attempts_node_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
    ],
  )
  const nodeChildren = createTable(
    tableNames.nodeChildren,
    {
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      childKey: text('child_key').notNull(),
      kind: enums.nodeChildKind('kind').notNull(),
      status: enums.nodeStatus('status').notNull(),
      ordinal: integer('ordinal').notNull().default(0),
      itemKey: text('item_key'),
      item: jsonb('item'),
      input: jsonb('input'),
      output: jsonb('output'),
      error: jsonb('error'),
      childRunId: uuid('child_run_id'),
      currentAttemptId: uuid('current_attempt_id'),
      attemptCount: integer('attempt_count').notNull().default(0),
      version: integer('version').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({
        name: 'workflow_node_children_pkey',
        columns: [t.runId, t.nodeName, t.childKey],
      }),
      index('workflow_node_children_node_idx').on(t.runId, t.nodeName),
      index('workflow_node_children_child_run_idx').on(t.childRunId),
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
  const runLeases = createTable(
    tableNames.runLeases,
    {
      runId: uuid('run_id').primaryKey(),
      leaseToken: text('lease_token').notNull(),
      version: integer('version').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      foreignKey({
        name: 'workflow_run_leases_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )
  const commands = createTable(
    tableNames.commands,
    {
      id: uuid('id').primaryKey(),
      kind: enums.commandKind('kind').notNull(),
      runId: uuid('run_id').notNull(),
      workflowName: text('workflow_name'),
      taskName: text('task_name'),
      activityName: text('activity_name'),
      nodeName: text('node_name'),
      attemptId: uuid('attempt_id'),
      payload: jsonb('payload').notNull().default({}),
      runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
      priority: integer('priority').notNull().default(0),
      leaseOwner: text('lease_owner'),
      leaseToken: text('lease_token'),
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
      deliveryCount: integer('delivery_count').notNull().default(0),
      lastError: jsonb('last_error'),
      deadAt: timestamp('dead_at', { withTimezone: true }),
      reapedAt: timestamp('reaped_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (t) => [
      index('workflow_commands_run_idx').on(t.runId),
      index('workflow_commands_claim_idx').on(
        t.kind,
        t.priority.desc(),
        t.runAt,
        t.createdAt,
        t.id,
      ),
      uniqueIndex('workflow_commands_continue_dedup_idx')
        .on(t.runId)
        .where(sql.raw("kind = 'continue' AND lease_token IS NULL")),
      foreignKey({
        name: 'workflow_commands_run_fk',
        columns: [t.runId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )

  return {
    tables: {
      schemaVersion,
      schedules,
      runs,
      nodes,
      attempts,
      nodeChildren,
      runLeases,
      commands,
    },
    enums,
  }
}
