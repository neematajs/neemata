import type {
  TAnyCallableContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import {
  IsCallableContract,
  IsRouterContract,
  IsStreamContract,
} from '@nmtjs/contract'

import type { ClientOptions } from '../client.ts'
import type { RpcLayerApi } from '../layers/rpc.ts'
import type {
  ClientTransportFactory,
  TransportOptionsOf,
} from '../transport.ts'
import type {
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider,
  StreamCallOptions,
} from '../types.ts'
import { Client } from '../client.ts'

const collectProcedures = (router: TAnyRouterContract) => {
  const procedures = new Map<string, TAnyCallableContract>()

  const visit = (route: TRouteContract, path: string[] = []) => {
    if (IsRouterContract(route)) {
      for (const [key, child] of Object.entries(route.routes)) {
        visit(child, [...path, key])
      }
      return
    }

    if (IsCallableContract(route)) {
      procedures.set(path.join('/'), route)
    }
  }

  visit(router)
  return procedures
}

export class RuntimeContractTransformer {
  #procedures: Map<string, TAnyCallableContract>

  constructor(router: TAnyRouterContract) {
    this.#procedures = collectProcedures(router)
  }

  encode(procedure: string, payload: any) {
    return this.#contract(procedure).input.encode(payload)
  }

  decode(procedure: string, payload: any) {
    return this.#contract(procedure).output.decode(payload)
  }

  #contract(procedure: string) {
    const contract = this.#procedures.get(procedure)
    if (!contract) throw new Error(`Procedure not found: ${procedure}`)
    return contract
  }
}

const buildCallers = <Callers>(
  rpc: RpcLayerApi,
  router: TAnyRouterContract,
) => {
  const call: Record<string, any> = Object.create(null)
  const stream: Record<string, any> = Object.create(null)

  const visit = (route: TRouteContract, path: string[]) => {
    if (IsRouterContract(route)) {
      for (const [key, child] of Object.entries(route.routes)) {
        visit(child, [...path, key])
      }
      return
    }

    if (!IsCallableContract(route)) return

    const procedure = path.join('/')
    const isStream = IsStreamContract(route)
    const invoke = (payload?: unknown, options?: StreamCallOptions) => {
      return rpc.call(procedure, payload, options, { stream: isStream })
    }

    // only the tree the procedure belongs to grows the intermediate namespaces
    let target = isStream ? stream : call
    for (const key of path.slice(0, -1)) {
      target[key] = target[key] ?? Object.create(null)
      target = target[key]
    }
    target[path[path.length - 1]] = invoke
  }

  visit(router, [])

  return { call, stream } as Callers
}

export class RuntimeClient<
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
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider
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
      new RuntimeContractTransformer(options.contract),
      (rpc) => buildCallers(rpc, options.contract),
    )
  }
}
