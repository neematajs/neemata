import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

type Casing = 'snake' | 'camel' | 'pascal'

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

export type WorkflowPostgresDrizzleSchemaConfig = {
  readonly schema?: string
  readonly casing?: Casing
  readonly tables?: Partial<Record<TableKey, string>>
  readonly enums?: Partial<Record<EnumKey, string>>
}

export type WorkflowPostgresRuntimeSchemaConfig = {
  readonly schema?: string
  readonly tables: Record<TableKey, string>
  readonly enums: Record<EnumKey, string>
}

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

const modelNames = {
  schemaVersion: {
    table: {
      snake: 'workflow_schema_version',
      camel: 'workflowSchemaVersion',
      pascal: 'WorkflowSchemaVersion',
    },
  },
  runs: {
    table: {
      snake: 'workflow_runs',
      camel: 'workflowRuns',
      pascal: 'WorkflowRuns',
    },
  },
  nodes: {
    table: {
      snake: 'workflow_nodes',
      camel: 'workflowNodes',
      pascal: 'WorkflowNodes',
    },
  },
  attempts: {
    table: {
      snake: 'workflow_attempts',
      camel: 'workflowAttempts',
      pascal: 'WorkflowAttempts',
    },
  },
  childLinks: {
    table: {
      snake: 'workflow_child_links',
      camel: 'workflowChildLinks',
      pascal: 'WorkflowChildLinks',
    },
  },
  mapItemSets: {
    table: {
      snake: 'workflow_map_item_sets',
      camel: 'workflowMapItemSets',
      pascal: 'WorkflowMapItemSets',
    },
  },
  mapItems: {
    table: {
      snake: 'workflow_map_items',
      camel: 'workflowMapItems',
      pascal: 'WorkflowMapItems',
    },
  },
  runLeases: {
    table: {
      snake: 'workflow_run_leases',
      camel: 'workflowRunLeases',
      pascal: 'WorkflowRunLeases',
    },
  },
  commands: {
    table: {
      snake: 'workflow_commands',
      camel: 'workflowCommands',
      pascal: 'WorkflowCommands',
    },
  },
} as const satisfies Record<TableKey, { readonly table: Record<Casing, string> }>

const enumNames = {
  runKind: {
    snake: 'workflow_run_kind',
    camel: 'workflowRunKind',
    pascal: 'WorkflowRunKind',
  },
  nodeKind: {
    snake: 'workflow_node_kind',
    camel: 'workflowNodeKind',
    pascal: 'WorkflowNodeKind',
  },
  runStatus: {
    snake: 'workflow_run_status',
    camel: 'workflowRunStatus',
    pascal: 'WorkflowRunStatus',
  },
  nodeStatus: {
    snake: 'workflow_node_status',
    camel: 'workflowNodeStatus',
    pascal: 'WorkflowNodeStatus',
  },
  attemptStatus: {
    snake: 'workflow_attempt_status',
    camel: 'workflowAttemptStatus',
    pascal: 'WorkflowAttemptStatus',
  },
  commandKind: {
    snake: 'workflow_command_kind',
    camel: 'workflowCommandKind',
    pascal: 'WorkflowCommandKind',
  },
} as const satisfies Record<EnumKey, Record<Casing, string>>

const tableKeys = Object.keys(modelNames) as TableKey[]
const enumKeys = Object.keys(enumNames) as EnumKey[]

const defaultTableName = (key: TableKey, casing: Casing) => {
  return modelNames[key].table[casing]
}

const tableName = (
  key: TableKey,
  config: WorkflowPostgresDrizzleSchemaConfig,
) => config.tables?.[key] ?? defaultTableName(key, config.casing ?? 'snake')

const enumName = (
  key: EnumKey,
  config: WorkflowPostgresDrizzleSchemaConfig,
) => config.enums?.[key] ?? enumNames[key][config.casing ?? 'snake']

function createEnums(names: Record<EnumKey, string>, schema: string | undefined) {
  const schemaBuilder = schema ? pgSchema(schema) : undefined
  const createEnum = (
    name: string,
    values: readonly [string, ...string[]],
  ) =>
    schemaBuilder
      ? schemaBuilder.enum(name, values)
      : pgEnum(name, values)

  return {
    runKind: createEnum(names.runKind, runKindValues),
    nodeKind: createEnum(names.nodeKind, nodeKindValues),
    runStatus: createEnum(names.runStatus, runStatusValues),
    nodeStatus: createEnum(names.nodeStatus, nodeStatusValues),
    attemptStatus: createEnum(names.attemptStatus, attemptStatusValues),
    commandKind: createEnum(names.commandKind, commandKindValues),
  }
}

export function createSchema<
  const Config extends WorkflowPostgresDrizzleSchemaConfig = {},
>(config: Config = {} as Config) {
  const tables = Object.fromEntries(
    tableKeys.map((key) => [key, tableName(key, config)]),
  ) as Record<TableKey, string>
  const enumConfig = Object.fromEntries(
    enumKeys.map((key) => [key, enumName(key, config)]),
  ) as Record<EnumKey, string>
  const enums = createEnums(enumConfig, config.schema)
  const createTable = (
    config.schema ? pgSchema(config.schema).table : pgTable
  ) as typeof pgTable

  const schemaVersion = createTable(
    tables.schemaVersion,
    {
        id: integer('id').primaryKey().default(1),
        version: integer('version').notNull(),
        installedAt: timestamp('installed_at', { withTimezone: true })
          .notNull()
          .defaultNow(),
      },
    (t) => [
      check('workflow_schema_version_singleton_chk', sql`${t.id} = 1`),
    ],
  )
  const runs = createTable(
      tables.runs,
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
    tables.nodes,
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
      primaryKey({ name: 'workflow_nodes_pk', columns: [t.runId, t.name] }),
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
    tables.attempts,
    {
        id: uuid('id').primaryKey(),
        runId: uuid('run_id').notNull(),
        nodeName: text('node_name').notNull(),
        identityKey: text('identity_key').unique(),
        identity: jsonb('identity'),
        status: enums.attemptStatus('status').notNull(),
        workerId: text('worker_id'),
        leaseToken: text('lease_token'),
        attemptNumber: integer('attempt_number').notNull(),
        input: jsonb('input').notNull(),
        idempotencyKey: jsonb('idempotency_key'),
        output: jsonb('output'),
        error: jsonb('error'),
        dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull(),
        heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
        completedAt: timestamp('completed_at', { withTimezone: true }),
      },
    (t) => [
      foreignKey({
        name: 'workflow_attempts_node_fk',
        columns: [t.runId, t.nodeName],
        foreignColumns: [nodes.runId, nodes.name],
      }).onDelete('cascade'),
    ],
  )
  const childLinks = createTable(
    tables.childLinks,
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
    tables.mapItemSets,
    {
        runId: uuid('run_id').notNull(),
        nodeName: text('node_name').notNull(),
        keys: jsonb('keys').notNull(),
      },
    (t) => [
      primaryKey({
        name: 'workflow_map_item_sets_pk',
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
    tables.mapItems,
    {
        runId: uuid('run_id').notNull(),
        nodeName: text('node_name').notNull(),
        itemIndex: integer('item_index').notNull(),
        identityKey: text('identity_key').notNull().unique(),
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
        name: 'workflow_map_items_pk',
        columns: [t.runId, t.nodeName, t.itemIndex],
      }),
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
    tables.runLeases,
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
    tables.commands,
    {
      id: uuid('id').primaryKey(),
      kind: enums.commandKind('kind').notNull(),
      runId: uuid('run_id').notNull(),
      workflowName: text('workflow_name'),
      taskName: text('task_name'),
      activityName: text('activity_name'),
      nodeName: text('node_name'),
      attemptId: uuid('attempt_id'),
      payload: jsonb('payload').notNull(),
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
      index('workflow_commands_claim_idx').on(
        t.kind,
        t.leaseToken,
        t.runAt,
        t.priority,
      ),
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
    runtime: { schema: config.schema, tables, enums: enumConfig },
  }
}
