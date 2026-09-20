import * as Schema from 'effect/Schema'

import type {
  BranchCaseDefinition,
  Schema as WorkflowSchema,
  WorkflowNode,
} from '../types/index.ts'

const jsonCodecs = new WeakMap<
  WorkflowSchema,
  Schema.Codec<unknown, Schema.Json>
>()
const nodeCodecs = new WeakMap<WorkflowNode, WorkflowSchema>()
// Re-entry decodes every completed node, so parsers are compiled once per schema.
const decoders = new WeakMap<WorkflowSchema, (value: unknown) => unknown>()
const encoders = new WeakMap<WorkflowSchema, (value: unknown) => unknown>()

function storedCodec(schema: WorkflowSchema) {
  let codec = jsonCodecs.get(schema)
  if (!codec) {
    codec = Schema.toCodecJson(schema)
    jsonCodecs.set(schema, codec)
  }
  return codec
}

function compiled(
  cache: WeakMap<WorkflowSchema, (value: unknown) => unknown>,
  compile: (schema: WorkflowSchema) => (value: unknown) => unknown,
  schema: WorkflowSchema,
) {
  let run = cache.get(schema)
  if (!run) {
    run = compile(schema)
    cache.set(schema, run)
  }
  return run
}

export function decodeSchemaValue(
  schema: WorkflowSchema,
  value: unknown,
  label: string,
) {
  try {
    return compiled(decoders, Schema.decodeUnknownSync, schema)(value)
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error })
  }
}

export function encodeStoredValue(
  schema: WorkflowSchema | undefined,
  value: unknown,
  label: string,
) {
  try {
    // A workflow with no output schema may finish without a value. All other
    // untyped outputs must already be JSON; only a codec can restore rich types.
    if (!schema && value === undefined) return undefined
    return compiled(
      encoders,
      Schema.encodeUnknownSync,
      schema ? storedCodec(schema) : Schema.Json,
    )(value)
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error })
  }
}

export function decodeStoredValue(
  schema: WorkflowSchema | undefined,
  value: unknown,
  label: string,
) {
  return schema ? decodeSchemaValue(storedCodec(schema), value, label) : value
}

function caseOutput(member: BranchCaseDefinition) {
  if ('output' in member) return member.output
  return member.target.output
}

function outputCodec(schema: WorkflowSchema | undefined): WorkflowSchema {
  return schema ? storedCodec(schema) : Schema.Unknown
}

function outputField(schema: WorkflowSchema | undefined) {
  // JSON drops undefined object properties. Only schema-less child outputs may
  // be absent; a declared output must still satisfy its codec on resumption.
  return schema ? storedCodec(schema) : Schema.optionalKey(Schema.Unknown)
}

function nodeOutputCodec(
  node: WorkflowNode,
  selectedCase?: string,
): WorkflowSchema {
  const cached = nodeCodecs.get(node)
  if (cached) return cached
  let codec: WorkflowSchema
  switch (node.kind) {
    case 'activity':
      return storedCodec(node.output)
    case 'task':
      return storedCodec(node.task.output)
    case 'workflow':
      return outputCodec(node.workflow.output)
    case 'branch': {
      const member =
        selectedCase === undefined ? undefined : node.cases[selectedCase]
      if (!member)
        throw new Error(
          `Missing selected branch case [${node.name}.${selectedCase}]`,
        )
      // Cases may converge on the same Type with different Encoded forms.
      // The selected case owns the stored encoding, not the convergence schema.
      return outputCodec(caseOutput(member))
    }
    case 'parallel':
      codec = Schema.Struct(
        Object.fromEntries(
          Object.entries(node.cases).map(([key, member]) => [
            key,
            outputField(caseOutput(member)),
          ]),
        ),
      )
      break
    case 'mapTask':
    case 'mapWorkflow':
      codec = Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            item: storedCodec(node.item),
            index: Schema.Number,
            runId: Schema.String,
            output: outputField(
              node.kind === 'mapTask' ? node.task.output : node.workflow.output,
            ),
          }),
        ),
      })
      break
  }
  // Declarations are immutable. Cache aggregate schemas, never decoded values;
  // branch cases above retain their own encodings via storedCodec.
  nodeCodecs.set(node, codec)
  return codec
}

export function decodeNodeOutput(
  node: WorkflowNode,
  value: unknown,
  selectedCase?: string,
) {
  return decodeSchemaValue(
    nodeOutputCodec(node, selectedCase),
    value,
    `node output [${node.name}]`,
  )
}
