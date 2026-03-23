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

const buildStaticCallers = (
  rpc: RpcLayerApi,
  isStream: boolean,
  path: string[] = [],
): Record<string, unknown> => {
  const createProxy = <T>(
    target: Record<string, unknown>,
    current: string[],
  ) => {
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'then') return obj

        const nextPath = [...current, String(prop)]
        const caller = (
          payload?: unknown,
          options?: Partial<ClientCallOptions>,
        ) => {
          return rpc.call(nextPath.join('/'), payload, {
            ...options,
            _stream_response: isStream || options?._stream_response,
          })
        }

        return createProxy(caller as any, nextPath)
      },
    }) as T
  }

  return createProxy(Object.create(null), path)
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
        call: buildStaticCallers(rpc, false),
        stream: buildStaticCallers(rpc, true),
      }),
    )
  }
}
