import { randomUUID } from 'node:crypto'

import type { JsonRecord, WorkflowPostgresConnection } from './connection.ts'

export const id = () => randomUUID()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isUuid = (value: string) => uuidPattern.test(value)

export const json = (value: unknown) => JSON.stringify(value)

/** Builds `{key: value}` or nothing, so SQL NULL never reaches the domain. */
export const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
) =>
  value === undefined || value === null
    ? ({} as Partial<Record<K, V>>)
    : ({ [key]: value } as Record<K, V>)

export const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const isUniqueViolation = (error: unknown) => {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === '23505') return true
  return (
    'message' in error &&
    String(error.message).includes(
      'duplicate key value violates unique constraint',
    )
  )
}

export const parseJsonColumn = (value: unknown): unknown =>
  typeof value === 'string' ? JSON.parse(value) : value

// jsonb-aggregated rows arrive as plain JSON, so the row shape is the schema's
// own and is trusted here exactly as pg's native row decoding is trusted.
export const jsonRow = <T>(value: unknown): T | undefined => {
  const parsed = parseJsonColumn(value)
  return isRecord(parsed) ? (parsed as T) : undefined
}

export const jsonRows = <T>(value: unknown): readonly T[] => {
  const parsed = parseJsonColumn(value)
  return Array.isArray(parsed) ? (parsed.filter(isRecord) as T[]) : []
}

export const one = async <T extends JsonRecord>(
  db: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) => {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

export const many = async <T extends JsonRecord>(
  db: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) => (await db.query<T>(sql, params)).rows
