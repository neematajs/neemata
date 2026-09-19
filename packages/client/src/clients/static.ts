import type { TAnyRouterContract } from '@nmtjs/contract'

import type { ClientOptions } from '../client.ts'
import type { RpcLayerApi } from '../layers/rpc.ts'
import type {
  ClientTransportFactory,
  TransportOptionsOf,
} from '../transport.ts'
import type {
  StaticInputContractTypeProvider,
  StaticOutputContractTypeProvider,
  StreamCallOptions,
} from '../types.ts'
import { Client } from '../client.ts'
import { BaseClientTransformer } from '../transformers.ts'

const buildCallers = <Callers>(rpc: RpcLayerApi, stream: boolean) => {
  const createProxy = <T extends object>(target: T, current: string[]) => {
    return new Proxy(target, {
      get: (_obj, prop) => {
        // callers must not look thenable: awaiting one (or returning it from
        // an async function) would otherwise invoke it with `resolve` as the
        // payload and fire a real RPC
        if (prop === 'then') return undefined

        const path = [...current, String(prop)]
        const caller = (payload?: unknown, options?: StreamCallOptions) => {
          return rpc.call(path.join('/'), payload, options, { stream })
        }

        return createProxy(caller, path)
      },
    })
  }

  const root: Record<string, unknown> = Object.create(null)
  // the proxy answers any path; the contract decides which ones are real
  return createProxy(root, []) as Callers
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
    options: ClientOptions<RouterContract, SafeCall>,
    transport: Transport,
    transportOptions: TransportOptionsOf<Transport>,
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
