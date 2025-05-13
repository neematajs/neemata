import type { TAnyAPIContract } from '@nmtjs/contract'
import { ProtocolBaseTransformer } from '@nmtjs/protocol/client'
import { BaseClient } from './common.ts'

export class StaticClient<
  APIContract extends TAnyAPIContract,
  SafeCall extends boolean = false,
> extends BaseClient<APIContract, SafeCall> {
  protected transformer: ProtocolBaseTransformer

  constructor(
    ...args: ConstructorParameters<typeof BaseClient<APIContract, SafeCall>>
  ) {
    super(...args)

    this.transformer = new ProtocolBaseTransformer()

    this.callers = new Proxy(Object(), {
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
              this._call(namespace as string, procedure as string, payload, {
                ...options,
                timeout: options?.timeout ?? this.options.timeout,
              })
          },
        })
      },
    })
  }
}
