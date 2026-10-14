import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import * as Schema from 'effect/Schema'
import * as Transferable from 'effect/workers/Transferable'

export const TestRpcs = RpcGroup.make(
  Rpc.make('ping', { success: Schema.String }),
  Rpc.make('port', { payload: { port: Transferable.MessagePort } }),
  Rpc.make('crash'),
  Rpc.make('stop', { payload: { timeoutMs: Schema.Number } }),
)
