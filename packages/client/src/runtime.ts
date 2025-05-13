import type { TAnyAPIContract } from '@nmtjs/contract'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolBaseTransformer } from '@nmtjs/protocol/client'
import { NeemataTypeError, NeverType } from '@nmtjs/type'
import { BaseClient, ClientError } from './common.ts'

export class RuntimeContractTransformer extends ProtocolBaseTransformer {
  protected contract: TAnyAPIContract

  constructor(contract: TAnyAPIContract) {
    super()

    this.contract = contract
  }

  decodeEvent(namespace: string, event: string, payload: any) {
    const type = this.contract.namespaces[namespace].events[event].payload
    return type.decode(payload)
  }

  decodeRPC(namespace: string, procedure: string, payload: any) {
    const type =
      this.contract.namespaces[namespace].procedures[procedure].output
    if (type instanceof NeverType) return undefined
    return type.decode(payload)
  }

  decodeRPCChunk(namespace: string, procedure: string, payload: any) {
    const type =
      this.contract.namespaces[namespace].procedures[procedure].stream
    if (type instanceof NeverType) return undefined
    return type.decode(payload)
  }

  encodeRPC(namespace: string, procedure: string, payload: any) {
    const type = this.contract.namespaces[namespace].procedures[procedure].input
    if (type instanceof NeverType) return undefined
    try {
      return type.encode(payload)
    } catch (error) {
      if (error instanceof NeemataTypeError) {
        throw new ClientError(
          ErrorCode.ValidationError,
          `Invalid payload for ${namespace}.${procedure}: ${error.message}`,
          error.issues,
        )
      }
      throw error
    }
  }
}

export class RuntimeClient<
  APIContract extends TAnyAPIContract,
  SafeCall extends boolean,
> extends BaseClient<APIContract, SafeCall> {
  protected transformer: RuntimeContractTransformer

  constructor(
    public contract: APIContract,
    ...args: ConstructorParameters<typeof BaseClient<APIContract, SafeCall>>
  ) {
    super(...args)

    this.transformer = new RuntimeContractTransformer(this.contract)

    const namespaces = Object.entries(this.contract.namespaces)
    for (const [namespaceKey, namespace] of namespaces) {
      this.callers[namespaceKey] = {} as any

      const procedures = Object.entries(namespace.procedures)

      for (const [procedureKey, procedure] of procedures) {
        this.callers[namespaceKey][procedureKey] = (payload, options) =>
          this._call(namespace.name, procedure.name, payload, {
            timeout: procedure.timeout || namespace.timeout || options.timeout,
            ...options,
          })
      }
    }
  }
}
