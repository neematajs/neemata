import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { task, workflow } from '../../src/dsl/index.ts'

/** The payment provider; the worker supplies it. */
export class Payments extends Context.Service<
  Payments,
  {
    readonly charge: (invoice: string, cents: number) => Effect.Effect<string>
  }
>()('billing/Payments') {}

const Order = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(['manual', 'automatic']),
  cents: Schema.NumberFromString,
})
const Invoice = Schema.Struct({ id: Schema.String, cents: Schema.Number })
const Approval = Schema.Struct({ id: Schema.String, approver: Schema.String })
const Receipt = Schema.Struct({ id: Schema.String, paidBy: Schema.String })
const Summary = Schema.Struct({
  order: Schema.String,
  invoice: Schema.String,
  paidBy: Schema.String,
})

export const CreateInvoice = task({
  name: 'billing.invoice',
  pool: 'billing',
  input: Order,
  output: Invoice,
  handler: (order) =>
    Effect.succeed({ id: `inv-${order.id}`, cents: order.cents }),
})

export const ChargeCard = task({
  name: 'billing.charge',
  pool: 'payments',
  input: Invoice,
  output: Receipt,
  retry: { attempts: 3 },
  timeout: '30s',
  handler: (invoice) =>
    Effect.gen(function* () {
      const payments = yield* Payments
      const paidBy = yield* payments.charge(invoice.id, invoice.cents)
      return { id: invoice.id, paidBy }
    }),
})

export const RequestApproval = task({
  name: 'billing.approval',
  pool: 'billing',
  input: Invoice,
  output: Approval,
  handler: (invoice) => Effect.succeed({ id: invoice.id, approver: 'finance' }),
})

export const RecordPayment = task({
  name: 'billing.record',
  pool: 'billing',
  input: Approval,
  output: Receipt,
  handler: (approval) =>
    Effect.succeed({ id: approval.id, paidBy: approval.approver }),
})

/** The manual case takes two steps, so it is a workflow of its own. */
export const ManualBilling = workflow(
  { name: 'billing.manual', pool: 'billing', input: Invoice, output: Receipt },
  function* (w) {
    const approval = yield* w.task('approval', RequestApproval, {
      input: w.input,
    })
    return yield* w.task('record', RecordPayment, { input: approval })
  },
)

export const Billing = workflow(
  {
    name: 'billing',
    pool: 'billing',
    input: Order,
    output: Summary,
    timeout: '1h',
  },
  function* (w) {
    const invoice = yield* w.task('invoice', CreateInvoice, { input: w.input })

    const receipt = yield* w.branch('payment', {
      select: Effect.map(w.input, (order) => order.mode),
      cases: (p) => ({
        manual: p.workflow(ManualBilling, { input: invoice }),
        automatic: p.task(ChargeCard, {
          input: invoice,
          retry: { attempts: 5 },
        }),
      }),
    })

    return Effect.gen(function* () {
      const order = yield* w.input
      return {
        order: order.id,
        invoice: (yield* invoice).id,
        paidBy: (yield* receipt).paidBy,
      }
    })
  },
)
