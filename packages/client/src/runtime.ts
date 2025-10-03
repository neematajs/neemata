import type {
  TAnyAPIContract,
  TAnyProcedureContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import { IsProcedureContract, IsRouterContract } from '@nmtjs/contract'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolBaseTransformer } from '@nmtjs/protocol/client'
import { NeemataTypeError, t } from '@nmtjs/type'

import type {
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider,
} from './common.ts'
import { BaseClient, ClientError } from './common.ts'

export class RuntimeContractTransformer extends ProtocolBaseTransformer {
  constructor(protected procedures: Map<string, TAnyProcedureContract>) {
    super()
  }

  decodeRPC(procedure: string, payload: any) {
    const contract = this.getProcedureContract(procedure)
    const type = contract.output
    if (type instanceof t.NeverType) return undefined
    return payload
  }

  decodeRPCChunk(procedure: string, payload: any) {
    const contract = this.getProcedureContract(procedure)
    const type = contract.stream
    if (!type || type instanceof t.NeverType) return undefined
    return type.decode(payload)
  }

  encodeRPC(procedure: string, payload: any) {
    const contract = this.getProcedureContract(procedure)
    const type = contract.input
    if (type instanceof t.NeverType) return undefined
    try {
      return type.encode(payload)
    } catch (error) {
      if (error instanceof NeemataTypeError) {
        throw new ClientError(
          ErrorCode.ValidationError,
          `Invalid payload for ${procedure}: ${error.message}`,
          error.issues,
        )
      }
      throw error
    }
  }

  protected getProcedureContract(procedure: string) {
    const proc = this.procedures.get(procedure)
    if (!proc) {
      throw new ClientError(
        ErrorCode.NotFound,
        `Procedure contract not found for procedure: ${procedure}`,
      )
    }
    return proc
  }

  protected build(router: TAnyRouterContract) {
    const routes: TRouteContract[] = Object.values(router.routes)
    for (const route of routes) {
      if (IsRouterContract(route)) {
        this.build(route)
      } else if (IsProcedureContract(route)) {
        this.procedures.set(route.name!, route)
      }
    }
  }
}

export class RuntimeClient<
  APIContract extends TAnyAPIContract,
  SafeCall extends boolean = false,
> extends BaseClient<
  APIContract,
  SafeCall,
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider
> {
  protected transformer: RuntimeContractTransformer
  protected procedures = new Map<string, TAnyProcedureContract>()

  constructor(
    public contract: APIContract,
    ...args: ConstructorParameters<typeof BaseClient<APIContract, SafeCall>>
  ) {
    super(...args)

    this.resolveProcedures(this.contract.router)
    this.transformer = new RuntimeContractTransformer(this.procedures)
    this.callers = this.buildCallers()
  }

  protected resolveProcedures(router: TAnyRouterContract) {
    const routes: TRouteContract[] = Object.values(router.routes)
    for (const route of routes) {
      if (IsRouterContract(route)) {
        this.resolveProcedures(route)
      } else if (IsProcedureContract(route)) {
        this.procedures.set(route.name!, route)
      }
    }
  }

  protected buildCallers(): any {
    const callers: any = Object.create(null)

    for (const [name, procedure] of this.procedures) {
      const parts = name.split('/')
      let current = callers
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (i === parts.length - 1) {
          current[part] = (payload: any, options: any = {}) =>
            this._call(name, payload, {
              timeout:
                procedure.timeout || options.timeout || this.options.timeout,
              ...options,
            })
        } else {
          if (!current[part]) {
            current[part] = {}
          }
          current = current[part]
        }
      }
    }

    return callers
  }
}
