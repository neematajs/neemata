import type { TAnyAPIContract } from '@nmtjs/contract'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import {
  ProtocolBaseClient,
  ProtocolBaseTransformer,
  type ProtocolTransport,
} from '@nmtjs/protocol/client'
import { ErrorCode } from '@nmtjs/protocol/common'
import { type BaseTypeAny, NeverType } from '@nmtjs/type'
import { type Compiled, compile } from '@nmtjs/type/compiler'
import { ClientError } from './common.ts'
import type {
  ClientCallers,
  ResolveAPIContract,
  ResolveClientEvents,
  RuntimeContractTypeProvider,
} from './types.ts'

export class RuntimeContractTransformer extends ProtocolBaseTransformer {
  #contract: TAnyAPIContract
  #types = new Set<BaseTypeAny>()
  #compiled = new Map<BaseTypeAny, Compiled>()

  constructor(contract: TAnyAPIContract) {
    super()

    this.#contract = contract

    for (const namespace of Object.values(contract.namespaces)) {
      for (const procedure of Object.values(namespace.procedures)) {
        const { input, output, stream } = procedure
        this.#registerType(input)
        this.#registerType(output)
        this.#registerType(stream)
      }

      for (const subscription of Object.values(namespace.subscriptions)) {
        const { input, output } = subscription
        this.#registerType(input)
        this.#registerType(output)

        for (const event of Object.values(subscription.events)) {
          this.#registerType(event.payload)
        }
      }

      for (const event of Object.values(namespace.events)) {
        this.#registerType(event.payload)
      }
    }

    this.#compile()
  }

  decodeEvent(namespace: string, event: string, payload: any) {
    const type = this.#contract.namespaces[namespace].events[event].payload
    if (type instanceof NeverType) return undefined
    const compiled = this.#compiled.get(type)!
    return compiled.decode(payload)
  }

  decodeRPC(namespace: string, procedure: string, payload: any) {
    const type =
      this.#contract.namespaces[namespace].procedures[procedure].output
    if (type instanceof NeverType) return undefined
    const compiled = this.#compiled.get(type)!
    return compiled.decode(payload)
  }

  decodeRPCChunk(namespace: string, procedure: string, payload: any) {
    const type =
      this.#contract.namespaces[namespace].procedures[procedure].stream
    if (type instanceof NeverType) return undefined

    const compiled = this.#compiled.get(type)!
    return compiled.decode(payload)
  }

  encodeRPC(namespace: string, procedure: string, payload: any) {
    const type =
      this.#contract.namespaces[namespace].procedures[procedure].input
    if (type instanceof NeverType) return undefined

    const compiled = this.#compiled.get(type)!
    if (!compiled.check(payload)) {
      const errors = compiled.errors(payload)
      throw new ClientError(
        ErrorCode.ValidationError,
        'Invalid RPC payload',
        errors,
      )
    }

    return compiled.encode(payload)
  }

  #registerType(type: BaseTypeAny) {
    this.#types.add(type)
  }

  #compile() {
    for (const type of this.#types) {
      this.#compiled.set(type, compile(type))
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
