import {
  getDecodeSchema,
  getEncodeSchema,
  isWireSchemaCodec,
  validateSchema,
} from '@nmtjs/common/schema'

import type {
  MapNodeImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  ResolvedRunUnique,
  RunUniqueConstraint,
  Schema,
  WorkflowNode,
} from '../../types/index.ts'
import type { StoredNode } from '../state.ts'
import {
  runWorkflowUserCallback,
  runWorkflowUserCallbackAsync,
} from './context.ts'

export function hasStoredNodeInput(node: {
  readonly input?: unknown
}): boolean {
  return Object.prototype.hasOwnProperty.call(node, 'input')
}

export async function decodeSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): Promise<unknown> {
  if (!isWireSchemaCodec(schema)) {
    throw new TypeError(`${label} schema must be a WireSchema.Codec`)
  }
  try {
    return await validateSchema(getDecodeSchema(schema), value)
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error })
  }
}

export async function encodeSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): Promise<unknown> {
  if (!isWireSchemaCodec(schema)) {
    throw new TypeError(`${label} schema must be a WireSchema.Codec`)
  }
  try {
    return await validateSchema(getEncodeSchema(schema), value)
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error })
  }
}

export async function canonicalizeSchemaInput(
  schema: Schema,
  value: unknown,
  label: string,
): Promise<{ readonly decoded: unknown; readonly encoded: unknown }> {
  const decoded = await decodeSchemaValue(schema, value, label)
  return {
    decoded,
    encoded: await encodeSchemaValue(schema, decoded, label),
  }
}

export async function encodeWorkflowUserSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): Promise<unknown> {
  return await runWorkflowUserCallbackAsync(() =>
    encodeSchemaValue(schema, value, label),
  )
}

export async function canonicalizeWorkflowUserSchemaInput(
  schema: Schema,
  value: unknown,
  label: string,
): Promise<{ readonly decoded: unknown; readonly encoded: unknown }> {
  return await runWorkflowUserCallbackAsync(() =>
    canonicalizeSchemaInput(schema, value, label),
  )
}

export async function canonicalizeMapItems(
  itemSchema: Schema,
  items: readonly unknown[],
  label: string,
): Promise<
  readonly { readonly decoded: unknown; readonly encoded: unknown }[]
> {
  return await runWorkflowUserCallbackAsync(() =>
    Promise.all(
      items.map((item, index) =>
        canonicalizeSchemaInput(itemSchema, item, `${label}.${index}`),
      ),
    ),
  )
}

export async function decodeWorkflowNodeOutput(
  workflow: WorkflowImplementation,
  node: StoredNode,
): Promise<unknown> {
  const declaration = getWorkflowNodeDeclaration(workflow, node.name)
  const label = `workflow node output [${workflow.workflow.name}.${node.name}]`

  if (declaration.kind === 'activity') {
    return await decodeSchemaValue(declaration.output, node.output, label)
  }
  if (declaration.kind === 'task') {
    return await decodeSchemaValue(declaration.task.output, node.output, label)
  }
  if (declaration.kind === 'workflow') {
    return declaration.workflow.output
      ? await decodeSchemaValue(declaration.workflow.output, node.output, label)
      : node.output
  }
  if (declaration.kind === 'branch') {
    const selected = node.selectedCase
      ? declaration.cases[node.selectedCase]
      : undefined
    if (!selected) return node.output
    if (selected.kind === 'activity') {
      const activity = selected as { readonly output: Schema }
      return await decodeSchemaValue(activity.output, node.output, label)
    }
    if (selected.kind === 'task') {
      const target = (
        selected as {
          readonly target: { readonly output: Schema }
        }
      ).target
      return await decodeSchemaValue(target.output, node.output, label)
    }
    const target = (
      selected as {
        readonly target: { readonly output?: Schema }
      }
    ).target
    return target.output
      ? await decodeSchemaValue(target.output, node.output, label)
      : node.output
  }
  if (declaration.kind === 'parallel') {
    const stored = node.output as Record<string, unknown>
    return Object.fromEntries(
      await Promise.all(
        Object.entries(declaration.cases).map(async ([key, member]) => {
          const memberOutput = stored[key]
          if (member.kind === 'activity') {
            const activity = member as { readonly output: Schema }
            return [
              key,
              await decodeSchemaValue(
                activity.output,
                memberOutput,
                `${label}.${key}`,
              ),
            ]
          }
          const outputSchema = (
            member as {
              readonly target: { readonly output?: Schema }
            }
          ).target.output
          return [
            key,
            outputSchema
              ? await decodeSchemaValue(
                  outputSchema,
                  memberOutput,
                  `${label}.${key}`,
                )
              : memberOutput,
          ]
        }),
      ),
    )
  }

  const stored = node.output as {
    readonly items: readonly {
      readonly item: unknown
      readonly index: number
      readonly output?: unknown
      readonly [key: string]: unknown
    }[]
  }
  const outputSchema =
    declaration.kind === 'mapTask'
      ? declaration.task.output
      : declaration.workflow.output
  return {
    items: await Promise.all(
      stored.items.map(async (item) => ({
        ...item,
        item: await decodeSchemaValue(
          declaration.item,
          item.item,
          `${label}.${item.index}.item`,
        ),
        ...(item.output === undefined || outputSchema === undefined
          ? {}
          : {
              output: await decodeSchemaValue(
                outputSchema,
                item.output,
                `${label}.${item.index}.output`,
              ),
            }),
      })),
    ),
  }
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

export function resolveUnique(
  unique: unknown,
  ...args: readonly unknown[]
): RunUniqueConstraint | undefined {
  if (!unique) return undefined
  if (typeof unique === 'function') {
    return {
      key: runWorkflowUserCallback(() => unique(...args) as readonly unknown[]),
    }
  }

  if (
    typeof unique === 'object' &&
    unique !== null &&
    'key' in unique &&
    typeof unique.key === 'function'
  ) {
    const { key, scope, behavior } = unique as {
      key: (...args: readonly unknown[]) => readonly unknown[]
      scope?: RunUniqueConstraint['scope']
      behavior?: RunUniqueConstraint['behavior']
    }
    return {
      key: runWorkflowUserCallback(() => key(...args)),
      ...(scope === undefined ? {} : { scope }),
      ...(behavior === undefined ? {} : { behavior }),
    }
  }

  throw new Error('Invalid unique definition')
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
