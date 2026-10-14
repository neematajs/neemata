import type { NeemWorkerErrorOrigin } from '@nmtjs/neem/internal/shared/errors'
import type { SerializedError } from '@nmtjs/neem/internal/utils'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import * as Schema from 'effect/Schema'
import * as Transferable from 'effect/workers/Transferable'

import { runtimeUpstreamsSchema } from './runtime-schema.ts'

export type { HostRunnerData as RunnerWorkerData } from '@nmtjs/neem/internal/host/runner-protocol'
export type {
  RuntimeWorkerData as ThreadWorkerData,
  WorkerPatchResult,
} from '@nmtjs/neem/internal/worker/protocol'

// Only application-owned data bypasses JSON encoding; its envelope is validated.
const opaque = Transferable.schema(Schema.Unknown, () => [])
const error = Schema.ErrorInstance({ includeStack: true })
const startFailure = Schema.Struct({
  origin: Schema.Literals(['bootstrap', 'start']),
  error,
})
export type WorkerStartFailure = typeof startFailure.Type

// Fatal reporting must remain synchronous when a thread is about to exit.
export const FATAL_FRAME = 2
export type WorkerFatal = SerializedError & { origin: NeemWorkerErrorOrigin }
export type FatalFrame = readonly [typeof FATAL_FRAME, WorkerFatal]

export const workerUpdateSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('Patch'),
    filename: Schema.String,
    seq: Schema.Int,
    changedIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('FullReload'),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal('Noop') }),
])
const patchResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('applied'),
    delivered: Schema.Boolean,
    patches: Schema.Int,
  }),
  Schema.Struct({
    outcome: Schema.Literals(['rejected', 'unavailable']),
    delivered: Schema.Boolean,
    patches: Schema.Int,
    reason: Schema.String,
  }),
])
const ExitBudget = {
  timeoutMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
}

export const ThreadRpcs = RpcGroup.make(
  Rpc.make('start', { success: runtimeUpstreamsSchema, error: startFailure }),
  Rpc.make('patch', {
    payload: {
      update: workerUpdateSchema,
      url: Schema.optionalKey(Schema.String),
    },
    success: patchResult,
  }),
  Rpc.make('stop', { payload: ExitBudget }),
)
export type ThreadRpcs = RpcGroup.Rpcs<typeof ThreadRpcs>

export const RunnerRpcs = RpcGroup.make(
  Rpc.make('plan', {
    success: Schema.Struct({
      workers: Schema.Union([
        Schema.Array(opaque),
        Schema.Record(Schema.String, Schema.Array(opaque)),
      ]),
      options: Schema.optionalKey(opaque),
    }),
    error,
  }),
  Rpc.make('start', {
    payload: {
      threads: Schema.Array(
        Schema.Struct({ name: Schema.String, port: Transferable.MessagePort }),
      ),
    },
    error,
  }),
  Rpc.make('stop', { error }),
  Rpc.make('shutdown', { payload: ExitBudget }),
)
export type RunnerRpcs = RpcGroup.Rpcs<typeof RunnerRpcs>
