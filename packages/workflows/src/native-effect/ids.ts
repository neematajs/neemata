import * as Schema from 'effect/Schema'

/** Identifies one execution of one workflow or task. */
export const ExecutionId = Schema.String.pipe(
  Schema.brand('@nmtjs/workflows/native-effect/ExecutionId'),
)
export type ExecutionId = typeof ExecutionId.Type
