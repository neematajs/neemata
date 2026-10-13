import type { GraphPresentation } from '../../inspector/graph.ts'
import type { WorkflowRuntimeAdapter } from '../../runtime/client.ts'
import type { WorkflowScheduler } from '../../runtime/scheduler.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { MissingDefinitions } from './definitions.ts'
import { prepareRunDefinition } from '../../runtime/definition.ts'
import {
  nextStoredScheduleRunAt,
  normalizeScheduleDefinitions,
  startStoredScheduleRun,
  type StoredWorkflowSchedule,
} from '../../runtime/scheduler.ts'
import { assertDefinitions, saveDefinitions } from './definitions.ts'
import { id, json, many, one, timestampColumn, timestampParam } from './sql.ts'

type PostgresWorkflowSchedulerContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
  readonly createRuntime: (
    connection: WorkflowPostgresConnection,
  ) => WorkflowRuntimeAdapter
}

type ScheduleRow = {
  readonly id: string
  readonly name: string
  readonly runnable_kind: 'workflow' | 'task'
  readonly runnable_name: string
  readonly execution_revision: string | null
  readonly graph_hash: string | null
  readonly graph_presentation: GraphPresentation | null
  readonly input: unknown
  readonly tags: unknown
  readonly cron: string | null
  readonly every_ms: number | string | null
  readonly enabled: boolean
  readonly next_run_at: Date | string
  readonly last_slot_at: Date | string | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
}

export function createPostgresWorkflowScheduler(
  ctx: PostgresWorkflowSchedulerContext,
): WorkflowScheduler {
  const { db, ready } = ctx

  return {
    async reconcile(entries) {
      await ready
      const date = Date.now()
      const normalized = normalizeScheduleDefinitions(entries, date)
      const definitions = normalized.map((entry) => prepareRunDefinition(entry))
      await db.transaction(async (tx) => {
        await tx.query(
          `SELECT pg_advisory_xact_lock(hashtext('workflow_schedules_reconcile'))`,
        )
        // Every entry is checked before the first write, and the definitions
        // commit with the schedule rows, so a fire never lacks what it pins.
        const missing: MissingDefinitions[] = []
        for (const [index, entry] of normalized.entries()) {
          const runnable = {
            kind: entry.runnableKind,
            name: entry.runnableName,
          }
          missing.push(
            await assertDefinitions(tx, runnable, definitions[index]!),
          )
        }
        await saveDefinitions(tx, mergeMissing(missing))

        if (normalized.length === 0) {
          await tx.query(`DELETE FROM workflow_schedules`)
          return
        }

        await tx.query(
          `
            DELETE FROM workflow_schedules
            WHERE name <> ALL($1::text[])
          `,
          [normalized.map((entry) => entry.name)],
        )

        for (const entry of normalized) {
          await tx.query(
            `
              INSERT INTO workflow_schedules (
                id,
                name,
                runnable_kind,
                runnable_name,
                execution_revision,
                graph_hash,
                graph_presentation,
                input,
                tags,
                cron,
                every_ms,
                enabled,
                next_run_at,
                created_at,
                updated_at
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $12,
                $13,
                $14::jsonb,
                $5::jsonb,
                $6::jsonb,
                $7,
                $8,
                $9,
                $10,
                now(),
                now()
              )
              ON CONFLICT (name) DO UPDATE
              SET runnable_kind = EXCLUDED.runnable_kind,
                  runnable_name = EXCLUDED.runnable_name,
                  execution_revision = EXCLUDED.execution_revision,
                  graph_hash = EXCLUDED.graph_hash,
                  graph_presentation = EXCLUDED.graph_presentation,
                  input = EXCLUDED.input,
                  tags = EXCLUDED.tags,
                  cron = EXCLUDED.cron,
                  every_ms = EXCLUDED.every_ms,
                  enabled = EXCLUDED.enabled,
                  next_run_at = CASE
                    WHEN workflow_schedules.cron IS DISTINCT FROM EXCLUDED.cron
                      OR workflow_schedules.every_ms IS DISTINCT FROM EXCLUDED.every_ms
                      OR (
                        workflow_schedules.enabled = false
                        AND EXCLUDED.enabled = true
                        AND workflow_schedules.next_run_at <= $11
                      )
                    THEN EXCLUDED.next_run_at
                    ELSE workflow_schedules.next_run_at
                  END,
                  updated_at = now()
            `,
            [
              id(),
              entry.name,
              entry.runnableKind,
              entry.runnableName,
              json(entry.input),
              json(entry.tags),
              entry.cron ?? null,
              entry.everyMs ?? null,
              entry.enabled,
              timestampParam(entry.nextRunAt),
              timestampParam(date),
              entry.executionRevision ?? null,
              entry.graphHash,
              entry.graphPresentation === undefined
                ? null
                : json(entry.graphPresentation),
            ],
          )
        }
      })
    },
    async fireDue(options = {}) {
      await ready
      const now = options.now ?? Date.now()
      const limit = normalizeScheduleLimit(options.limit)
      if (limit < 1) return { fired: 0 }

      return db.transaction(async (tx) => {
        const rows = await many<ScheduleRow>(
          tx,
          `
            SELECT *
            FROM workflow_schedules
            WHERE enabled = true
              AND next_run_at <= $1
            ORDER BY next_run_at ASC, name ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          `,
          [timestampParam(now), limit],
        )

        for (const row of rows) {
          const schedule = mapSchedule(row)
          const slot = schedule.nextRunAt
          const runtime = ctx.createRuntime(tx)
          await startStoredScheduleRun(runtime, schedule, slot)
          await tx.query(
            `
              UPDATE workflow_schedules
              SET last_slot_at = $2,
                  next_run_at = $3,
                  updated_at = now()
              WHERE id = $1
            `,
            [
              schedule.id,
              timestampParam(slot),
              timestampParam(nextStoredScheduleRunAt(schedule, now)),
            ],
          )
        }

        return { fired: rows.length }
      })
    },
    async list() {
      await ready
      const rows = await many<ScheduleRow>(
        db,
        `
          SELECT *
          FROM workflow_schedules
          ORDER BY name ASC
        `,
      )
      return rows.map(mapSchedule)
    },
    async trigger(name) {
      await ready
      return db.transaction(async (tx) => {
        const row = await one<ScheduleRow>(
          tx,
          `
            SELECT *
            FROM workflow_schedules
            WHERE name = $1
            FOR UPDATE
          `,
          [name],
        )
        if (!row) throw new Error(`Unknown workflow schedule [${name}]`)
        const schedule = mapSchedule(row)
        const run = await startStoredScheduleRun(
          ctx.createRuntime(tx),
          schedule,
          'manual',
        )
        await tx.query(
          `
            UPDATE workflow_schedules
            SET last_slot_at = $2,
                updated_at = now()
            WHERE id = $1
          `,
          [schedule.id, timestampParam(Date.now())],
        )
        return run
      })
    },
    async setEnabled(name, enabled) {
      await ready
      return db.transaction(async (tx) => {
        const row = await one<ScheduleRow>(
          tx,
          `
            SELECT *
            FROM workflow_schedules
            WHERE name = $1
            FOR UPDATE
          `,
          [name],
        )
        if (!row) throw new Error(`Unknown workflow schedule [${name}]`)
        const date = Date.now()
        const schedule = mapSchedule(row)
        const nextRunAt =
          enabled && !schedule.enabled && schedule.nextRunAt <= date
            ? nextStoredScheduleRunAt(schedule, date)
            : schedule.nextRunAt
        const updated = await one<ScheduleRow>(
          tx,
          `
            UPDATE workflow_schedules
            SET enabled = $2,
                next_run_at = $3,
                updated_at = now()
            WHERE name = $1
            RETURNING *
          `,
          [name, enabled, timestampParam(nextRunAt)],
        )
        return mapSchedule(updated!)
      })
    },
  }
}

function compareText(left: string, right: string) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

// One sorted pass over what every entry lacks keeps the lock order of a single
// start. Duplicates stay in: the save compares the second against the first.
function mergeMissing(missing: readonly MissingDefinitions[]) {
  const graphs = missing
    .flatMap((entry) => entry.graphs)
    .sort((left, right) => compareText(left.graphHash, right.graphHash))
  const revisions = missing
    .flatMap((entry) => entry.revisions)
    .sort((left, right) => compareText(left.key, right.key))

  return { graphs, revisions }
}

function mapSchedule(row: ScheduleRow): StoredWorkflowSchedule {
  const {
    execution_revision: executionRevision,
    graph_hash: graphHash,
    graph_presentation: graphPresentation,
  } = row

  return {
    id: row.id,
    name: row.name,
    runnableKind: row.runnable_kind,
    runnableName: row.runnable_name,
    // All three are NULL on schedules saved before revisions existed.
    ...(executionRevision === null ? {} : { executionRevision }),
    ...(graphHash === null ? {} : { graphHash }),
    ...(graphPresentation === null ? {} : { graphPresentation }),
    // The driver has already decoded jsonb; parsing a string input again
    // would read application data as another JSON document.
    input: row.input,
    tags: row.tags as Readonly<Record<string, string>>,
    ...(row.cron === null ? {} : { cron: row.cron }),
    ...(row.every_ms === null ? {} : { everyMs: Number(row.every_ms) }),
    enabled: row.enabled,
    nextRunAt: timestampColumn(row.next_run_at),
    ...(row.last_slot_at === null
      ? {}
      : { lastSlotAt: timestampColumn(row.last_slot_at) }),
    createdAt: timestampColumn(row.created_at),
    updatedAt: timestampColumn(row.updated_at),
  }
}

function normalizeScheduleLimit(limit: number | undefined) {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit < 1) return 0
  return limit
}
