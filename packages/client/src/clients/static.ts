import type { TAnyRouterContract } from '@nmtjs/contract'

import type { BaseClientOptions } from '../client.ts'
import type { RpcLayerApi } from '../layers/rpc.ts'
import type { ClientTransportFactory } from '../transport.ts'
import type {
  ClientCallOptions,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider,
} from '../types.ts'
import { Client } from '../client.ts'
import { BaseClientTransformer } from '../transformers.ts'

const buildCallers = (
  rpc: RpcLayerApi,
  isStream: boolean,
  path: string[] = [],
): Record<string, unknown> => {
  const createProxy = <T extends object>(target: T, current: string[]) => {
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'then') return obj

        const path = [...current, String(prop)]
        const caller = (
          payload?: unknown,
          options?: Partial<ClientCallOptions>,
        ) => {
          const procedure = path.join('/')
          const stream = isStream || options?._stream_response
          return rpc.call(procedure, payload, {
            ...options,
            _stream_response: stream,
          })
        }

        return createProxy(caller, path)
      },
    })
  }

  const root: Record<string, unknown> = Object.create(null)
  return createProxy(root, path)
}

export class StaticClient<
  Transport extends ClientTransportFactory<any, any> = ClientTransportFactory<
    any,
    any
  >,
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> extends Client<
  Transport,
  RouterContract,
  SafeCall,
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider
> {
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
    super(
      options,
      transport,
      transportOptions,
      new BaseClientTransformer(),
      (rpc) => ({
        call: buildCallers(rpc, false),
        stream: buildCallers(rpc, true),
      }),
    )
  }
}
