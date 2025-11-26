import type { TAnyRouterContract } from '@nmtjs/contract'

import type { BaseClientOptions } from '../common.ts'
import type { ClientTransportFactory } from '../transport.ts'
import type {
  ClientCallers,
  ClientCallOptions,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider,
} from '../types.ts'
import { BaseClient } from '../common.ts'
import { BaseClientTransformer } from '../transformers.ts'

export class StaticClient<
  Transport extends ClientTransportFactory<any, any> = ClientTransportFactory<
    any,
    any
  >,
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> extends BaseClient<
  Transport,
  RouterContract,
  SafeCall,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider
> {
  protected transformer: BaseClientTransformer

  constructor(
    options: BaseClientOptions<RouterContract, SafeCall>,
    transport: Transport,
    transportOptions: Transport extends ClientTransportFactory<
      any,
      infer Options
    >
      ? Options
      : never,
  ) {
    super(options, transport, transportOptions)
    this.transformer = new BaseClientTransformer()
  }

  override get call() {
    return this.createProxy(Object.create(null), false) as ClientCallers<
      this['_']['routes'],
      SafeCall,
      false
    >
  }

  override get stream() {
    return this.createProxy(Object.create(null), true) as ClientCallers<
      this['_']['routes'],
      SafeCall,
      true
    >
  }

  protected createProxy<T>(
    target: Record<string, unknown>,
    isStream: boolean,
    path: string[] = [],
  ) {
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'then') return obj
        const newPath = [...path, String(prop)]
        const caller = (
          payload?: unknown,
          options?: Partial<ClientCallOptions>,
        ) => this._call(newPath.join('/'), payload, options)
        return this.createProxy(caller as any, isStream, newPath)
      },
    }) as T
  }
}
