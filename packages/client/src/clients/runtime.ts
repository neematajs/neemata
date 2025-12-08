import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import { IsProcedureContract, IsRouterContract } from '@nmtjs/contract'

import type { BaseClientOptions } from '../core.ts'
import type { ClientTransportFactory } from '../transport.ts'
import type {
  ClientCallers,
  ClientCallOptions,
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider,
} from '../types.ts'
import { BaseClient } from '../core.ts'

export class RuntimeContractTransformer {
  #procedures = new Map<string, TAnyProcedureContract>()

  constructor(router: TAnyRouterContract) {
    const registerProcedures = (r: TRouteContract, path: string[] = []) => {
      if (IsRouterContract(r)) {
        for (const [key, route] of Object.entries(r.routes)) {
          registerProcedures(route, [...path, key])
        }
      } else if (IsProcedureContract(r)) {
        const fullName = [...path].join('/')
        this.#procedures.set(fullName, r)
      }
    }
    registerProcedures(router)
  }

  encode(_procedure: string, payload: any) {
    const procedure = this.#procedures.get(_procedure)
    if (!procedure) throw new Error(`Procedure not found: ${_procedure}`)
    return procedure.input.encode(payload)
  }

  decode(_procedure: string, payload: any) {
    const procedure = this.#procedures.get(_procedure)
    if (!procedure) throw new Error(`Procedure not found: ${_procedure}`)
    return procedure.output.decode(payload)
  }
}

export class RuntimeClient<
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
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider
> {
  protected readonly transformer: RuntimeContractTransformer

  readonly #procedures = new Map<string, TAnyProcedureContract>()
  readonly #callers!: ClientCallers<this['_']['routes'], SafeCall, boolean>

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

    this.resolveProcedures(this.options.contract)
    this.transformer = new RuntimeContractTransformer(this.options.contract)
    this.#callers = this.buildCallers()
  }

  override get call() {
    return this.#callers as ClientCallers<this['_']['routes'], SafeCall, false>
  }

  override get stream() {
    return this.#callers as ClientCallers<this['_']['routes'], SafeCall, true>
  }

  protected resolveProcedures(router: TAnyRouterContract, path: string[] = []) {
    for (const [key, route] of Object.entries(router.routes)) {
      if (IsRouterContract(route)) {
        this.resolveProcedures(route, [...path, key])
      } else if (IsProcedureContract(route)) {
        const fullName = [...path, key].join('/')
        this.#procedures.set(fullName, route)
      }
    }
  }

  protected buildCallers(): ClientCallers<
    this['_']['routes'],
    SafeCall,
    boolean
  > {
    const callers: Record<string, any> = Object.create(null)

    for (const [name, { stream }] of this.#procedures) {
      const parts = name.split('/')
      let current = callers
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (i === parts.length - 1) {
          current[part] = (
            payload?: unknown,
            options?: Partial<ClientCallOptions>,
          ) =>
            this._call(name, payload, {
              ...options,
              _stream_response: !!stream,
            })
        } else {
          current[part] = current[part] ?? Object.create(null)
          current = current[part]
        }
      }
    }

    return callers as ClientCallers<this['_']['routes'], SafeCall, boolean>
  }
}
