import type {
  BranchCaseDefinition,
  Json,
  Schema,
  WorkflowNode,
} from '../types/index.ts'

function invalid(label: string, cause: unknown): Error {
  return new Error(`Invalid ${label}`, { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Without a codec nothing can restore a rich value, so it must survive JSON.
function assertJson(value: unknown, path: string): asserts value is Json {
  if (value === null) return
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertJson(member, `${path}[${index}]`))
    return
  }
  const prototype = isRecord(value) ? Object.getPrototypeOf(value) : undefined
  if (prototype === Object.prototype || prototype === null) {
    for (const [key, member] of Object.entries(value as object))
      assertJson(member, `${path}.${key}`)
    return
  }
  throw new TypeError(`Expected a JSON value at ${path}`)
}

export function encodeStoredValue(
  schema: Schema | undefined,
  value: unknown,
  label: string,
) {
  try {
    // A workflow with no output schema may finish without a value. All other
    // untyped outputs must already be JSON; only a codec can restore rich types.
    if (!schema && value === undefined) return undefined
    if (schema) return schema.encode(value)
    assertJson(value, '$')
    return value
  } catch (error) {
    throw invalid(label, error)
  }
}

export function decodeStoredValue(
  schema: Schema | undefined,
  value: unknown,
  label: string,
) {
  if (!schema) return value
  try {
    return schema.decode(value)
  } catch (error) {
    throw invalid(label, error)
  }
}

function caseOutput(member: BranchCaseDefinition) {
  if ('output' in member) return member.output
  return member.target.output
}

function decodeRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected an object')
  return value
}

// JSON drops undefined object properties. Only schema-less child outputs may
// be absent; a declared output must still satisfy its codec on resumption.
function decodeOutputField(
  schema: Schema | undefined,
  owner: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
) {
  if (schema) target[key] = schema.decode(owner[key])
  else if (key in owner) target[key] = owner[key]
}

function decodeAggregate(
  node: WorkflowNode,
  value: unknown,
  selectedCase?: string,
): unknown {
  switch (node.kind) {
    case 'activity':
      return node.output.decode(value)
    case 'task':
      return node.task.output.decode(value)
    case 'workflow':
      return node.workflow.output ? node.workflow.output.decode(value) : value
    case 'branch': {
      const member =
        selectedCase === undefined ? undefined : node.cases[selectedCase]
      if (!member)
        throw new Error(
          `Missing selected branch case [${node.name}.${selectedCase}]`,
        )
      // Cases may converge on the same Type with different Encoded forms.
      // The selected case owns the stored encoding, not the convergence schema.
      const schema = caseOutput(member)
      return schema ? schema.decode(value) : value
    }
    case 'parallel': {
      const stored = decodeRecord(value)
      const outputs: Record<string, unknown> = {}
      for (const [key, member] of Object.entries(node.cases))
        decodeOutputField(caseOutput(member), stored, key, outputs)
      return outputs
    }
    case 'mapTask':
    case 'mapWorkflow': {
      const { items } = decodeRecord(value)
      if (!Array.isArray(items)) throw new TypeError('Expected items array')
      const output =
        node.kind === 'mapTask' ? node.task.output : node.workflow.output
      return {
        items: items.map((stored: unknown) => {
          const entry = decodeRecord(stored)
          if (typeof entry.index !== 'number')
            throw new TypeError('Expected a numeric item index')
          if (typeof entry.runId !== 'string')
            throw new TypeError('Expected an item run id')
          const item: Record<string, unknown> = {
            item: node.item.decode(entry.item),
            index: entry.index,
            runId: entry.runId,
          }
          decodeOutputField(output, entry, 'output', item)
          return item
        }),
      }
    }
  }
}

export function decodeNodeOutput(
  node: WorkflowNode,
  value: unknown,
  selectedCase?: string,
) {
  try {
    return decodeAggregate(node, value, selectedCase)
  } catch (error) {
    throw invalid(`node output [${node.name}]`, error)
  }
}
