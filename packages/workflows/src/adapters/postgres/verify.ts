import type { WorkflowPostgresConnection } from './connection.ts'
import { WORKFLOW_POSTGRES_SCHEMA_MANIFEST } from './manifest.ts'
import { many, one } from './sql.ts'

const stringArray = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string') return []
  const content =
    value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value
  if (!content) return []
  return content.split(',').map((item) => item.replaceAll('"', ''))
}
const sameStringArray = (left: unknown, right: readonly string[]) => {
  const normalized = stringArray(left)
  return (
    normalized.length === right.length &&
    normalized.every((item, index) => item === right[index])
  )
}
const normalizeIndexPredicate = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replaceAll('"', '')
        .replace(/[()]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    : undefined

export async function verifyPostgresWorkflowSchema(
  db: WorkflowPostgresConnection,
) {
  const expectedColumns = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.columns,
  ).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, definition]) => ({
      key: `${table}.${column}`,
      table,
      column,
      type: definition.type,
      nullable: definition.nullable,
    })),
  )
  const [
    enums,
    enumLabels,
    tables,
    columns,
    constraints,
    indexes,
    constraintDefinitions,
    indexDefinitions,
  ] = await Promise.all([
    many(
      db,
      `
          SELECT t.typname AS name
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema()
            AND t.typname = ANY($1)
        `,
      [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums]],
    ),
    many<{
      enum_name: string
      enum_label: string
    }>(
      db,
      `
          SELECT t.typname AS enum_name, e.enumlabel AS enum_label
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = current_schema()
            AND t.typname = ANY($1)
          ORDER BY t.typname, e.enumsortorder
        `,
      [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums]],
    ),
    many(
      db,
      `
          SELECT tablename AS name
          FROM pg_tables
          WHERE schemaname = current_schema()
            AND tablename = ANY($1)
        `,
      [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables]],
    ),
    many<{
      table_name: string
      column_name: string
      udt_name: string
      is_nullable: string
    }>(
      db,
      `
          SELECT table_name, column_name, udt_name, is_nullable
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ANY($1)
        `,
      [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables]],
    ),
    many(
      db,
      `
          SELECT c.conname AS name
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = current_schema()
            AND c.conname = ANY($1)
        `,
      [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints]],
    ),
    many(
      db,
      `
          SELECT indexname AS name
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = ANY($1)
        `,
      [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexes]],
    ),
    many<{
      name: string
      table_name: string
      type: string
      columns: unknown
    }>(
      db,
      `
          SELECT
            c.conname AS name,
            rel.relname AS table_name,
            c.contype AS type,
            array_remove(array_agg(att.attname ORDER BY ord.ordinality), NULL) AS columns
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          LEFT JOIN unnest(c.conkey) WITH ORDINALITY AS ord(attnum, ordinality)
            ON true
          LEFT JOIN pg_attribute att
            ON att.attrelid = rel.oid AND att.attnum = ord.attnum
          WHERE n.nspname = current_schema()
            AND c.conname = ANY($1)
          GROUP BY c.conname, rel.relname, c.contype
        `,
      [Object.keys(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraintDefinitions)],
    ),
    many<{
      name: string
      table_name: string
      unique: boolean
      columns: unknown
      directions: unknown
      predicate: string | null
    }>(
      db,
      `
          SELECT
            idx.relname AS name,
            tbl.relname AS table_name,
            i.indisunique AS unique,
            array_remove(array_agg(att.attname ORDER BY ord.ordinality), NULL) AS columns,
            array_remove(
              array_agg(
                CASE
                  WHEN (i.indoption[ord.ordinality - 1]::int & 1) = 1
                    THEN 'DESC'
                  ELSE 'ASC'
                END
                ORDER BY ord.ordinality
              ),
              NULL
            ) AS directions,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
          FROM pg_index i
          JOIN pg_class idx ON idx.oid = i.indexrelid
          JOIN pg_class tbl ON tbl.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = tbl.relnamespace
          LEFT JOIN unnest(i.indkey) WITH ORDINALITY AS ord(attnum, ordinality)
            ON true
          LEFT JOIN pg_attribute att
            ON att.attrelid = tbl.oid AND att.attnum = ord.attnum
          WHERE n.nspname = current_schema()
            AND idx.relname = ANY($1)
          GROUP BY idx.relname, tbl.relname, i.indisunique, i.indpred, i.indrelid
        `,
      [Object.keys(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexDefinitions)],
    ),
  ])

  const existing = new Set([
    ...enums.map((row) => row.name),
    ...tables.map((row) => row.name),
    ...constraints.map((row) => row.name),
    ...indexes.map((row) => row.name),
  ])
  const missing = [
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums,
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables,
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints,
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexes,
  ].filter((name) => !existing.has(name))

  if (missing.length > 0) {
    throw new Error(
      `Missing workflow Postgres schema objects: ${missing.join(', ')}`,
    )
  }

  const labelsByEnum = new Map<string, string[]>()
  for (const row of enumLabels) {
    const values = labelsByEnum.get(row.enum_name) ?? []
    values.push(row.enum_label)
    labelsByEnum.set(row.enum_name, values)
  }
  const invalidEnums = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enumValues,
  )
    .filter(
      ([name, values]) =>
        JSON.stringify(labelsByEnum.get(name) ?? []) !== JSON.stringify(values),
    )
    .map(([name]) => name)

  if (invalidEnums.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema enums: ${invalidEnums.join(', ')}`,
    )
  }

  const constraintDefinitionsByName = new Map(
    constraintDefinitions.map((definition) => [definition.name, definition]),
  )
  const invalidConstraints = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraintDefinitions,
  )
    .filter(([name, expected]) => {
      const actual = constraintDefinitionsByName.get(name)
      return (
        !actual ||
        actual.table_name !== expected.table ||
        actual.type !== expected.type ||
        !sameStringArray(actual.columns, expected.columns)
      )
    })
    .map(([name]) => name)

  if (invalidConstraints.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema constraints: ${invalidConstraints.join(', ')}`,
    )
  }

  const indexDefinitionsByName = new Map(
    indexDefinitions.map((definition) => [definition.name, definition]),
  )
  const invalidIndexes = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexDefinitions,
  )
    .filter(([name, expected]) => {
      const actual = indexDefinitionsByName.get(name)
      return (
        !actual ||
        actual.table_name !== expected.table ||
        actual.unique !== expected.unique ||
        !sameStringArray(actual.columns, expected.columns) ||
        !sameStringArray(
          actual.directions,
          'directions' in expected
            ? expected.directions
            : expected.columns.map(() => 'ASC'),
        ) ||
        normalizeIndexPredicate(actual.predicate) !==
          normalizeIndexPredicate(
            'predicate' in expected ? expected.predicate : undefined,
          )
      )
    })
    .map(([name]) => name)

  if (invalidIndexes.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema indexes: ${invalidIndexes.join(', ')}`,
    )
  }

  const columnsByKey = new Map(
    columns.map((column) => [
      `${column.table_name}.${column.column_name}`,
      column,
    ]),
  )
  const invalidColumns = expectedColumns
    .filter((expected) => {
      const column = columnsByKey.get(expected.key)
      return (
        !column ||
        column.udt_name !== expected.type ||
        (column.is_nullable === 'YES') !== expected.nullable
      )
    })
    .map((expected) => expected.key)

  if (invalidColumns.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema columns: ${invalidColumns.join(', ')}`,
    )
  }

  const versionRow = await one<{
    id: number
    version: number
  }>(
    db,
    `
      SELECT id, version
      FROM workflow_schema_version
      WHERE id = 1
    `,
  )

  if (!versionRow) {
    throw new Error('Missing workflow Postgres schema version')
  }
  if (versionRow.version !== WORKFLOW_POSTGRES_SCHEMA_MANIFEST.version) {
    throw new Error(
      `Unsupported workflow Postgres schema version [${versionRow.version}], expected [${WORKFLOW_POSTGRES_SCHEMA_MANIFEST.version}]`,
    )
  }
}
