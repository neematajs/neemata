import type { TAnyAPIContract } from '@nmtjs/contract'
import {
  type BaseClientFormat,
  ProtocolBaseClient,
  type ProtocolTransport,
} from '@nmtjs/protocol/client'

import type {
  ClientCallers,
  ResolveAPIContract,
  ResolveClientEvents,
  StaticContractTypeProvider,
} from './types.ts'

export class StaticClient<
  APIContract extends TAnyAPIContract,
  ResolvedAPIContract extends ResolveAPIContract<
    APIContract,
    StaticContractTypeProvider
  > = ResolveAPIContract<APIContract, StaticContractTypeProvider>,
> extends ProtocolBaseClient<ResolveClientEvents<ResolvedAPIContract>> {
  _!: ResolvedAPIContract

  #callers: ClientCallers<ResolvedAPIContract>

  constructor(options: {
    transport: ProtocolTransport
    format: BaseClientFormat
    timeout?: number
  }) {
    super(options)

    this.#callers = new Proxy(Object(), {
      get: (target, namespace) => {
        // `await client.call.namespaceName` or `await client.call.namespaceName.procedureName`
        // without explicitly calling a function implicitly calls .then() on target
        // FIXME: this basically makes "then" a reserved word
        if (namespace === 'then') return target
        return new Proxy(Object(), {
          get: (target, procedure) => {
            // `await client.call.namespaceName` or `await client.call.namespaceName.procedureName`
            // without explicitly calling a function implicitly calls .then() on target
            // FIXME: this basically makes "then" a reserved word
            if (procedure === 'then') return target
            return (payload, options) =>
              this._call(
                namespace as string,
                procedure as string,
                payload,
                options,
              )
          },
        })
      },
    })
  }

  get call() {
    return this.#callers
  }
}
