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
  | 'graphs'
  | 'revisions'
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
  graphs: 'workflow_graphs',
  revisions: 'workflow_revisions',
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

export type CreateSchemaOptions = {
  /**
   * GIN indexes over `workflow_runs.input`/`tags` for inspector search.
   * Off by default: they amplify every run insert, and most deployments
   * never filter by whole payloads.
   */
  readonly searchIndexes?: boolean
}

export function createSchema(options?: CreateSchemaOptions) {
  const searchIndexes = options?.searchIndexes ?? false
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
  // Definitions are shared by every run and schedule that names them and are
  // never deleted with one, so nothing here cascades from a run. `structure`
  // and `bindings` hold canonical JSON as text: they are compared byte for
  // byte, which jsonb's own key order and number format would not allow.
  const graphs = createTable(tableNames.graphs, {
    graphHash: text('graph_hash').primaryKey(),
    structure: text('structure').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  })
  const revisions = createTable(
    tableNames.revisions,
    {
      kind: enums.runKind('kind').notNull(),
      name: text('name').notNull(),
      revision: text('revision').notNull(),
      graphHash: text('graph_hash').notNull(),
      bindings: text('bindings').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (t) => [
      primaryKey({
        name: 'workflow_revisions_pkey',
        columns: [t.kind, t.name, t.revision],
      }),
      // Lets a run or schedule reference a revision together with its graph,
      // so neither can name a graph its revision was not saved with.
      unique('workflow_revisions_graph_key').on(
        t.kind,
        t.name,
        t.revision,
        t.graphHash,
      ),
      foreignKey({
        name: 'workflow_revisions_graph_fk',
        columns: [t.graphHash],
        foreignColumns: [graphs.graphHash],
      }),
    ],
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
      uniqueKey: jsonb('unique_key'),
      uniqueScope: text('unique_scope'),
      uniqueBehavior: text('unique_behavior'),
      // All three are NULL on runs created before revisions existed.
      executionRevision: text('execution_revision'),
      graphHash: text('graph_hash'),
      graphPresentation: jsonb('graph_presentation'),
      version: integer('version').notNull(),
      activeSince: timestamp('active_since', { withTimezone: true })
        .notNull()
        .defaultNow(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('workflow_runs_idempotency_idx')
        .on(t.idempotencyKey)
        .where(sql.raw('idempotency_key IS NOT NULL')),
      // the partial predicates ARE the uniqueness guarantees: at most one
      // non-terminal run per active-scoped key, one run ever per all-scoped
      // key; terminal statuses are frozen into the predicate by design
      uniqueIndex('workflow_runs_unique_active_idx')
        .on(t.uniqueKey)
        .where(
          sql.raw(
            "unique_key IS NOT NULL AND unique_scope = 'active' AND status NOT IN ('completed', 'cancelled', 'failed')",
          ),
        ),
      uniqueIndex('workflow_runs_unique_all_idx')
        .on(t.uniqueKey)
        .where(sql.raw("unique_key IS NOT NULL AND unique_scope = 'all'")),
      index('workflow_runs_parent_idx')
        .on(t.parentRunId)
        .where(sql.raw('parent_run_id IS NOT NULL')),
      index('workflow_runs_root_idx').on(t.rootRunId),
      // retention prune scans terminal roots by age every tick; without this
      // the sweep is a seq scan of the biggest table
      index('workflow_runs_prune_idx')
        .on(t.status, t.updatedAt)
        .where(sql.raw('parent_run_id IS NULL')),
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
      check(
        'workflow_runs_revision_graph_chk',
        sql`${t.executionRevision} IS NULL OR ${t.graphHash} IS NOT NULL`,
      ),
      foreignKey({
        name: 'workflow_runs_graph_fk',
        columns: [t.graphHash],
        foreignColumns: [graphs.graphHash],
      }),
      // MATCH SIMPLE: an unversioned run has no revision and is not checked.
      foreignKey({
        name: 'workflow_runs_revision_fk',
        columns: [t.kind, t.name, t.executionRevision, t.graphHash],
        foreignColumns: [
          revisions.kind,
          revisions.name,
          revisions.revision,
          revisions.graphHash,
        ],
      }),
    ],
  )
  const schedules = createTable(
    tableNames.schedules,
    {
      id: uuid('id').primaryKey(),
      name: text('name').notNull(),
      runnableKind: enums.runKind('runnable_kind').notNull(),
      runnableName: text('runnable_name').notNull(),
      // What the next fire pins its run to; NULL on schedules saved before
      // revisions existed.
      executionRevision: text('execution_revision'),
      graphHash: text('graph_hash'),
      graphPresentation: jsonb('graph_presentation'),
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
      check(
        'workflow_schedules_revision_graph_chk',
        sql`${t.executionRevision} IS NULL OR ${t.graphHash} IS NOT NULL`,
      ),
      foreignKey({
        name: 'workflow_schedules_graph_fk',
        columns: [t.graphHash],
        foreignColumns: [graphs.graphHash],
      }),
      foreignKey({
        name: 'workflow_schedules_revision_fk',
        columns: [
          t.runnableKind,
          t.runnableName,
          t.executionRevision,
          t.graphHash,
        ],
        foreignColumns: [
          revisions.kind,
          revisions.name,
          revisions.revision,
          revisions.graphHash,
        ],
      }),
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
      retryAttemptNumber: integer('retry_attempt_number').notNull(),
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
      cancellation: text('cancellation'),
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
      // The run's revision, copied for routing: a claim matches it exactly,
      // and NULL is the unversioned lane.
      revision: text('revision'),
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
      // every attempt dispatch checks for an existing command by attempt;
      // continuations carry no attempt and stay out of the index
      index('workflow_commands_attempt_idx')
        .on(t.attemptId)
        .where(sql.raw('attempt_id IS NOT NULL')),
      // dead-lettered commands accumulate until retention prunes them; keep
      // them out of the claim scan's index entirely. NULLS FIRST is what the
      // claim's `ORDER BY priority DESC` means: drizzle's default for a
      // descending column is NULLS LAST, an order the claim cannot scan, so
      // it would sort every ready command of the kind instead.
      index('workflow_commands_claim_idx')
        .on(t.kind, t.priority.desc().nullsFirst(), t.runAt, t.createdAt, t.id)
        .where(sql.raw('dead_at IS NULL')),
      index('workflow_commands_dead_idx')
        .on(t.deadAt)
        .where(sql.raw('dead_at IS NOT NULL')),
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
      graphs,
      revisions,
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
