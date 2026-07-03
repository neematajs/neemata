import { sql } from 'drizzle-orm'
import {
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

type TableKey =
  | 'schemaVersion'
  | 'runs'
  | 'nodes'
  | 'attempts'
  | 'childLinks'
  | 'mapItemSets'
  | 'mapItems'
  | 'runLeases'
  | 'commands'

type EnumKey =
  | 'runKind'
  | 'nodeKind'
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
  runs: 'workflow_runs',
  nodes: 'workflow_nodes',
  attempts: 'workflow_attempts',
  childLinks: 'workflow_child_links',
  mapItemSets: 'workflow_map_item_sets',
  mapItems: 'workflow_map_items',
  runLeases: 'workflow_run_leases',
  commands: 'workflow_commands',
} as const satisfies Record<TableKey, string>

const enumNames = {
  runKind: 'workflow_run_kind',
  nodeKind: 'workflow_node_kind',
  runStatus: 'workflow_run_status',
  nodeStatus: 'workflow_node_status',
  attemptStatus: 'workflow_attempt_status',
  commandKind: 'workflow_command_kind',
} as const satisfies Record<EnumKey, string>

function createEnums() {
  return {
    runKind: pgEnum(enumNames.runKind, runKindValues),
    nodeKind: pgEnum(enumNames.nodeKind, nodeKindValues),
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
      currentAttemptId: uuid('current_attempt_id'),
      nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
      attemptCount: integer('attempt_count').notNull(),
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
      foreignKey({
        name: 'workflow_nodes_current_attempt_fk',
        columns: [t.currentAttemptId],
        foreignColumns: [attempts.id],
      }).onDelete('set null'),
    ],
  )
  const attempts = createTable(
    tableNames.attempts,
    {
      id: uuid('id').primaryKey(),
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      identityKey: text('identity_key'),
      identity: jsonb('identity'),
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
      unique('workflow_attempts_identity_key_key').on(t.identityKey),
      foreignKey({
        name: 'workflow_attempts_node_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
    ],
  )
  const childLinks = createTable(
    tableNames.childLinks,
    {
      identityKey: text('identity_key').primaryKey(),
      identity: jsonb('identity').notNull(),
      parentRunId: uuid('parent_run_id').notNull(),
      parentNodeName: text('parent_node_name').notNull(),
      childRunId: uuid('child_run_id').notNull(),
      childKind: enums.runKind('child_kind').notNull(),
      childName: text('child_name').notNull(),
      workflowName: text('workflow_name').notNull(),
      taskName: text('task_name'),
      caseKey: text('case_key'),
      memberKey: text('member_key'),
      itemIndex: integer('item_index'),
      itemKey: text('item_key'),
    },
    (t) => [
      index('workflow_child_links_parent_node_idx').on(
        t.parentRunId,
        t.parentNodeName,
      ),
      foreignKey({
        name: 'workflow_child_links_parent_node_fk',
        columns: [t.parentRunId, t.parentNodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
      foreignKey({
        name: 'workflow_child_links_child_run_fk',
        columns: [t.childRunId],
        foreignColumns: [runs.id],
      }).onDelete('cascade'),
    ],
  )
  const mapItemSets = createTable(
    tableNames.mapItemSets,
    {
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      keys: jsonb('keys').notNull(),
    },
    (t) => [
      primaryKey({
        name: 'workflow_map_item_sets_pkey',
        columns: [t.runId, t.nodeName],
      }),
      foreignKey({
        name: 'workflow_map_item_sets_node_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
    ],
  )
  const mapItems = createTable(
    tableNames.mapItems,
    {
      runId: uuid('run_id').notNull(),
      nodeName: text('node_name').notNull(),
      itemIndex: integer('item_index').notNull(),
      identityKey: text('identity_key').notNull(),
      identity: jsonb('identity').notNull(),
      itemKey: text('item_key'),
      item: jsonb('item').notNull(),
      status: enums.nodeStatus('status').notNull(),
      output: jsonb('output'),
      error: jsonb('error'),
      childRunId: uuid('child_run_id'),
      attemptId: uuid('attempt_id'),
    },
    (t) => [
      primaryKey({
        name: 'workflow_map_items_pkey',
        columns: [t.runId, t.nodeName, t.itemIndex],
      }),
      unique('workflow_map_items_identity_key_key').on(t.identityKey),
      foreignKey({
        name: 'workflow_map_items_set_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [mapItemSets.runId, mapItemSets.nodeName],
      }).onDelete('cascade'),
      foreignKey({
        name: 'workflow_map_items_child_run_fk',
        columns: [t.childRunId],
        foreignColumns: [runs.id],
      }).onDelete('set null'),
      foreignKey({
        name: 'workflow_map_items_attempt_fk',
        columns: [t.attemptId],
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
      runs,
      nodes,
      attempts,
      childLinks,
      mapItemSets,
      mapItems,
      runLeases,
      commands,
    },
    enums,
  }
}
