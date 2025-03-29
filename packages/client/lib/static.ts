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

  constructor(transport: ProtocolTransport, format: BaseClientFormat) {
    super(transport, format)

    this.#callers = new Proxy(Object(), {
      get: (target, namespaceProp, receiver) => {
        // `await client.call.namespaceName` or `await client.call.namespaceName.procedureName`
        // without explicitly calling a function implicitly calls .then() on target
        // FIXME: this basically makes "then" a reserved word
        if (namespaceProp === 'then') return target
        return new Proxy(Object(), {
          get: (target, procedureProp, receiver) => {
            // `await client.call.namespaceName` or `await client.call.namespaceName.procedureName`
            // without explicitly calling a function implicitly calls .then() on target
            // FIXME: this basically makes "then" a reserved word
            if (procedureProp === 'then') return target
            return (payload, options) =>
              this._call(
                namespaceProp as string,
                procedureProp as string,
                payload,
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
