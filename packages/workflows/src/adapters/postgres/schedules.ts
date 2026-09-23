import type { WorkflowRuntimeAdapter } from '../../runtime/client.ts'
import type { WorkflowScheduler } from '../../runtime/scheduler.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import {
  nextStoredScheduleRunAt,
  normalizeScheduleDefinitions,
  startStoredScheduleRun,
  type StoredWorkflowSchedule,
} from '../../runtime/scheduler.ts'
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
      await db.transaction(async (tx) => {
        await tx.query(
          `SELECT pg_advisory_xact_lock(hashtext('workflow_schedules_reconcile'))`,
        )
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

function mapSchedule(row: ScheduleRow): StoredWorkflowSchedule {
  return {
    id: row.id,
    name: row.name,
    runnableKind: row.runnable_kind,
    runnableName: row.runnable_name,
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
