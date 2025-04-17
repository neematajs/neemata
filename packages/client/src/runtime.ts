import type { TAnyAPIContract } from '@nmtjs/contract'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import {
  ProtocolBaseClient,
  ProtocolBaseTransformer,
  type ProtocolTransport,
} from '@nmtjs/protocol/client'
import { ErrorCode } from '@nmtjs/protocol/common'
import { type BaseTypeAny, NeemataTypeError, NeverType } from '@nmtjs/type'
import { ClientError } from './common.ts'
import type {
  ClientCallers,
  ResolveAPIContract,
  ResolveClientEvents,
  RuntimeContractTypeProvider,
} from './types.ts'

export class RuntimeContractTransformer extends ProtocolBaseTransformer {
  #contract: TAnyAPIContract

  constructor(contract: TAnyAPIContract) {
    super()

    this.#contract = contract
  }

  decodeEvent(namespace: string, event: string, payload: any) {
    const type = this.#contract.namespaces[namespace].events[event].payload
    return type.decode(payload)
  }

  decodeRPC(namespace: string, procedure: string, payload: any) {
    const type =
      this.#contract.namespaces[namespace].procedures[procedure].output
    if (type instanceof NeverType) return undefined
    return type.decode(payload)
  }

  decodeRPCChunk(namespace: string, procedure: string, payload: any) {
    const type =
      this.#contract.namespaces[namespace].procedures[procedure].stream
    if (type instanceof NeverType) return undefined
    return type.decode(payload)
  }

  encodeRPC(namespace: string, procedure: string, payload: any) {
    const type =
      this.#contract.namespaces[namespace].procedures[procedure].input
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
  ResolvedAPIContract extends ResolveAPIContract<
    APIContract,
    RuntimeContractTypeProvider
  > = ResolveAPIContract<APIContract, RuntimeContractTypeProvider>,
> extends ProtocolBaseClient<ResolveClientEvents<ResolvedAPIContract>> {
  _!: ResolvedAPIContract
  #callers = {} as ClientCallers<ResolvedAPIContract>

  constructor(
    contract: APIContract,
    options: {
      transport: ProtocolTransport
      format: BaseClientFormat
      timeout?: number
    },
  ) {
    super({
      ...options,
      transformer: new RuntimeContractTransformer(contract),
    })

    const callers = {} as any

    for (const [namespaceKey, namespace] of Object.entries(
      contract.namespaces,
    )) {
      namespace.procedures

      callers[namespaceKey] = {} as any

      for (const [procedureKey, procedure] of Object.entries(
        namespace.procedures,
      )) {
        callers[namespaceKey][procedureKey] = (payload, options) =>
          this._call(namespace.name, procedure.name, payload, {
            timeout: namespace.timeout,
            ...options,
          })
      }
    }
    this.#callers = callers
  }

  get call() {
    return this.#callers
  }
}
