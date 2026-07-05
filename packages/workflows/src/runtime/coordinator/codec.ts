import type {
  MapNodeImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type { Schema, WorkflowNode } from '../../types/index.ts'
import { runWorkflowUserCallback } from './context.ts'

export function hasStoredNodeInput(node: {
  readonly input?: unknown
}): boolean {
  return Object.prototype.hasOwnProperty.call(node, 'input')
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
  workflow: WorkflowImplementation,
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

export function resolveIdempotency(
  idempotency: unknown,
  ...args: readonly unknown[]
): readonly unknown[] | undefined {
  if (!idempotency) return undefined
  if (typeof idempotency === 'function') {
    return runWorkflowUserCallback(
      () => idempotency(...args) as readonly unknown[],
    )
  }

  if (
    typeof idempotency === 'object' &&
    idempotency !== null &&
    'key' in idempotency &&
    typeof idempotency.key === 'function'
  ) {
    const key = idempotency.key
    return runWorkflowUserCallback(() => key(...args) as readonly unknown[])
  }

  throw new Error('Invalid idempotency definition')
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
