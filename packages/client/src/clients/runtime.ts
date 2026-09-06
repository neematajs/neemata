import type { WireSchema } from '@nmtjs/common/schema'
import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import {
  getDecodeSchema,
  getEncodeSchema,
  isWireSchemaCodec,
  validateSchema,
} from '@nmtjs/common/schema'
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

type DirectionalSchemas<Route extends TRouteContract> =
  Route extends TAnyProcedureContract
    ? Exclude<Route['input'] | Route['output'], WireSchema.Codec | undefined>
    : Route extends TAnyRouterContract
      ? DirectionalSchemas<Route['routes'][keyof Route['routes']]>
      : never

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
        if (route.input && !isWireSchemaCodec(route.input)) {
          throw new Error(
            `Runtime client procedure input must be a codec: ${path.join('/')}`,
          )
        }
        if (route.output && !isWireSchemaCodec(route.output)) {
          throw new Error(
            `Runtime client procedure output must be a codec: ${path.join('/')}`,
          )
        }
        this.#procedures.set(path.join('/'), route)
      }
    }

    registerProcedures(router)
  }

  async encode(procedure: string, payload: any) {
    const contract = this.#procedures.get(procedure)
    if (!contract) throw new Error(`Procedure not found: ${procedure}`)
    if (!contract.input) return undefined
    return await validateSchema(getEncodeSchema(contract.input), payload)
  }

  async decode(procedure: string, payload: any) {
    const contract = this.#procedures.get(procedure)
    if (!contract) throw new Error(`Procedure not found: ${procedure}`)
    if (!contract.output) return undefined
    return await validateSchema(getDecodeSchema(contract.output), payload)
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
    options: BaseClientOptions<RouterContract, SafeCall> &
      ([DirectionalSchemas<RouterContract>] extends [never] ? unknown : never),
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
