import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import { IsProcedureContract, IsRouterContract } from '@nmtjs/contract'

import type { BaseClientOptions } from '../client.ts'
import type { RpcLayerApi } from '../layers/rpc.ts'
import type { ClientTransportFactory } from '../transport.ts'
import type {
  ClientCallOptions,
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider,
} from '../types.ts'
import { Client } from '../client.ts'

export class RuntimeContractTransformer {
  #procedures = new Map<string, TAnyProcedureContract>()

  constructor(router: TAnyRouterContract) {
    const registerProcedures = (route: TRouteContract, path: string[] = []) => {
      if (IsRouterContract(route)) {
        for (const [key, child] of Object.entries(route.routes)) {
          registerProcedures(child, [...path, key])
        }
        return
      }

      if (IsProcedureContract(route)) {
        this.#procedures.set(path.join('/'), route)
      }
    }

    registerProcedures(router)
  }

  encode(procedure: string, payload: any) {
    const contract = this.#procedures.get(procedure)
    if (!contract) throw new Error(`Procedure not found: ${procedure}`)
    return contract.input.encode(payload)
  }

  decode(procedure: string, payload: any) {
    const contract = this.#procedures.get(procedure)
    if (!contract) throw new Error(`Procedure not found: ${procedure}`)
    return contract.output.decode(payload)
  }
}

const assignNested = (
  root: Record<string, any>,
  name: string,
  value: unknown,
) => {
  const parts = name.split('/')
  let current = root

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i === parts.length - 1) {
      current[part] = value
    } else {
      current[part] = current[part] ?? Object.create(null)
      current = current[part]
    }
  }
}

const buildRuntimeCallers = (
  rpc: RpcLayerApi,
  contract: TAnyRouterContract,
) => {
  const procedures = new Map<string, TAnyProcedureContract>()

  const resolveProcedures = (
    router: TAnyRouterContract,
    path: string[] = [],
  ) => {
    for (const [key, route] of Object.entries(router.routes)) {
      if (IsRouterContract(route)) {
        resolveProcedures(route, [...path, key])
      } else if (IsProcedureContract(route)) {
        procedures.set([...path, key].join('/'), route)
      }
    }
  }

  resolveProcedures(contract)

  const callers: Record<string, any> = Object.create(null)
  const streams: Record<string, any> = Object.create(null)

  for (const [name, procedure] of procedures) {
    const invoke = (
      payload?: unknown,
      options?: Partial<ClientCallOptions>,
    ) => {
      return rpc.call(name, payload, {
        ...options,
        _stream_response: !!procedure.stream,
      })
    }

    if (procedure.stream) {
      assignNested(streams, name, invoke)
    } else {
      assignNested(callers, name, invoke)
    }
  }

  return { call: callers, stream: streams }
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
      new RuntimeContractTransformer(options.contract),
      (rpc) => buildRuntimeCallers(rpc, options.contract),
    )
  }
}
