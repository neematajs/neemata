import type { TAnyAPIContract } from '@nmtjs/contract'
import { ProtocolBaseTransformer } from '@nmtjs/protocol/client'

import type {
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider,
} from './common.ts'
import { BaseClient } from './common.ts'

export class StaticClient<
  APIContract extends TAnyAPIContract,
  SafeCall extends boolean = false,
> extends BaseClient<
  APIContract,
  SafeCall,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider
> {
  protected transformer: ProtocolBaseTransformer

  constructor(
    ...args: ConstructorParameters<typeof BaseClient<APIContract, SafeCall>>
  ) {
    super(...args)
    this.transformer = new ProtocolBaseTransformer()
    this.callers = this.createProxy(Object.create(null))
  }

  protected createProxy(target: any, path: string[] = []): any {
    return new Proxy(target, {
      get: (obj, prop) => {
        // `await client.call.something` or `await client.call.something.nested`
        // without explicitly calling a function implicitly calls .then() on a target
        // FIXME: this basically makes "then" a reserved word for static Client
        if (prop === 'then') return obj
        const newPath = [...path, String(prop)]
        const caller = (payload, options) =>
          this._call(newPath.join('/'), payload, {
            ...options,
            timeout: options?.timeout ?? this.options.timeout,
          })
        return this.createProxy(caller, newPath)
      },
    })
  }
}
