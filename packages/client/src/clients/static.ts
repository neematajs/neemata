import type { TAnyRouterContract } from '@nmtjs/contract'

import type { BaseClientOptions } from '../common.ts'
import type { ClientTransport } from '../transport.ts'
import type {
  ClientCallers,
  ClientCallOptions,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider,
} from '../types.ts'
import { BaseClient } from '../common.ts'
import { BaseClientTransformer } from '../transformers.ts'

export class StaticClient<
  Transport extends ClientTransport<any, any> = ClientTransport<any, any>,
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
  #callProxy!: ClientCallers<this['_']['routes'], SafeCall>

  constructor(
    options: BaseClientOptions<RouterContract, SafeCall>,
    transport: Transport,
    transportOptions: Transport extends ClientTransport<any, infer Options>
      ? Options
      : never,
  ) {
    super(options, transport, transportOptions)
    this.transformer = new BaseClientTransformer()
    this.#callProxy = this.createProxy(Object.create(null))
  }

  override get call() {
    return this.#callProxy
  }

  protected createProxy(
    target: Record<string, unknown>,
    path: string[] = [],
  ): ClientCallers<this['_']['routes'], SafeCall> {
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'then') return obj
        const newPath = [...path, String(prop)]
        const caller = (
          payload?: unknown,
          options?: Partial<ClientCallOptions>,
        ) => this._call(newPath.join('/'), payload, options?.signal)
        return this.createProxy(caller as any, newPath)
      },
    }) as ClientCallers<this['_']['routes'], SafeCall>
  }
}
