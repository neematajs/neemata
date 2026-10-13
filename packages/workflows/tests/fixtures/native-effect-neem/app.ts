import { defineTask, defineWorkflow } from '@nmtjs/workflows/native-effect'
import * as Schema from 'effect/Schema'
import { DurableDeferred } from 'effect/workflow'

export const Approval = DurableDeferred.make('approval', {
  success: Schema.Boolean,
})

export const Render = defineTask('neem.render', {
  payload: { invoice: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ invoice }) => invoice,
  pool: 'render',
})

export const Invoice = defineWorkflow('neem.invoice', {
  payload: { invoice: Schema.String },
  success: Schema.Struct({ prepared: Schema.Number, rendered: Schema.Number }),
  idempotencyKey: ({ invoice }) => invoice,
})

export const definitions = [Render, Invoice]
