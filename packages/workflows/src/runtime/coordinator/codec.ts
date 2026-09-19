import type {
  AnyWorkflowImplementation,
  MapNodeImplementation,
} from '../../implement/index.ts'
import type {
  ResolvedRunUnique,
  RunUniqueConstraint,
  Schema,
  WorkflowNode,
} from '../../types/index.ts'
import { runWorkflowUserCallback } from './context.ts'

/**
 * Key absence, not `undefined`, is the "input already derived" marker: a node
 * input may legitimately be `undefined`, so both store adapters must omit the
 * key entirely until `setNodeInput` has run for the node.
 */
export function hasStoredNodeInput(node: {
  readonly input?: unknown
}): boolean {
  return Object.hasOwn(node, 'input')
}

export function decodeSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): unknown {
  try {
    return schema.decode(value as never)
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error })
  }
}

export function decodeWorkflowUserSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): unknown {
  return runWorkflowUserCallback(() => decodeSchemaValue(schema, value, label))
}

export function decodeMapItems(
  itemSchema: Schema,
  items: readonly unknown[],
  label: string,
): readonly unknown[] {
  return runWorkflowUserCallback(() =>
    items.map((item, index) =>
      decodeSchemaValue(itemSchema, item, `${label}.${index}`),
    ),
  )
}

export function getWorkflowNodeDeclaration(
  workflow: AnyWorkflowImplementation,
  nodeName: string,
): WorkflowNode {
  const node = workflow.workflow.nodes.find(
    (candidate) => candidate.name === nodeName,
  )
  if (!node) {
    throw new Error(
      `Missing workflow node declaration [${workflow.workflow.name}.${nodeName}]`,
    )
  }
  return node
}

type KeyCallback = (...args: readonly unknown[]) => readonly unknown[]

/** Both `idempotency` and `unique` accept the key callback bare or as `{ key }`. */
function keyCallback(definition: unknown): KeyCallback | undefined {
  if (typeof definition === 'function') return definition as KeyCallback
  if (
    typeof definition === 'object' &&
    definition !== null &&
    'key' in definition &&
    typeof definition.key === 'function'
  ) {
    return definition.key as KeyCallback
  }
  return undefined
}

export function resolveIdempotency(
  idempotency: unknown,
  ...args: readonly unknown[]
): readonly unknown[] | undefined {
  if (!idempotency) return undefined
  const key = keyCallback(idempotency)
  if (!key) throw new Error('Invalid idempotency definition')

  return runWorkflowUserCallback(() => key(...args))
}

export function resolveUnique(
  unique: unknown,
  ...args: readonly unknown[]
): RunUniqueConstraint | undefined {
  if (!unique) return undefined
  const key = keyCallback(unique)
  if (!key) throw new Error('Invalid unique definition')

  const resolved = runWorkflowUserCallback(() => key(...args))
  if (typeof unique === 'function') return { key: resolved }

  const { scope, behavior } = unique as Pick<
    RunUniqueConstraint,
    'scope' | 'behavior'
  >
  return {
    key: resolved,
    ...(scope === undefined ? {} : { scope }),
    ...(behavior === undefined ? {} : { behavior }),
  }
}

export function normalizeRunUnique(
  unique: RunUniqueConstraint | undefined,
): ResolvedRunUnique | undefined {
  if (!unique) return undefined
  return {
    key: unique.key,
    scope: unique.scope ?? 'active',
    behavior: unique.behavior ?? 'reject',
  }
}

export function resolveTags(
  tags: unknown,
  ...args: readonly unknown[]
): Readonly<Record<string, string>> | undefined {
  if (!tags) return undefined
  if (typeof tags === 'function') {
    return runWorkflowUserCallback(
      () => tags(...args) as Readonly<Record<string, string>>,
    )
  }

  throw new Error('Invalid tags definition')
}

export function mapConcurrencyLimit(node: MapNodeImplementation): number {
  if (
    node.concurrency !== undefined &&
    (!Number.isInteger(node.concurrency) || node.concurrency < 1)
  ) {
    throw new Error('Map node concurrency must be a positive integer')
  }

  return node.concurrency ?? Number.POSITIVE_INFINITY
}
