import type { TAnyAPIContract } from '@nmtjs/contract'
import {
  EventEmitter,
  type ProtocolBaseClientCallOptions,
  type ProtocolBaseTransformer,
  ProtocolError,
  type ProtocolTransport,
} from '@nmtjs/protocol/client'
import type {
  ClientCallers,
  ResolveAPIContract,
  ResolveClientEvents,
  RuntimeInputContractTypeProvider,
  RuntimeOutputContractTypeProvider,
} from './types.ts'

export * from './types.ts'

export class ClientError extends ProtocolError {}

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  TransportType,
} from '@nmtjs/protocol/common'

export abstract class BaseClient<
  APIContract extends TAnyAPIContract = TAnyAPIContract,
  SafeCall extends boolean = false,
> extends EventEmitter<
  ResolveClientEvents<
    ResolveAPIContract<
      APIContract,
      RuntimeInputContractTypeProvider,
      RuntimeOutputContractTypeProvider
    >
  >
> {
  _!: {
    api: ResolveAPIContract<
      APIContract,
      RuntimeInputContractTypeProvider,
      RuntimeOutputContractTypeProvider
    >
    safe: SafeCall
  }

  protected abstract transformer: ProtocolBaseTransformer
  protected auth: any

  constructor(
    protected transport: ProtocolTransport,
    protected options: { timeout: number; safe?: SafeCall },
  ) {
    super()
  }

  protected callers = {} as ClientCallers<this['_']['api'], this['_']['safe']>

  protected async _call(
    namespace: string,
    procedure: string,
    payload: any,
    options: ProtocolBaseClientCallOptions,
  ) {
    const call = await this.transport.call(
      namespace,
      procedure,
      payload,
      options,
      this.transformer,
    )
    if (this.options.safe) {
      return await call.promise
        .then((result) => ({ result }))
        .catch((error) => ({ error }))
    } else {
      return await call.promise.catch((error) => {
        throw error
      })
    }
  }

  get call() {
    return this.callers
  }

  setAuth(auth: any) {
    this.auth = auth
  }

  connect() {
    return this.transport.connect(this.auth, this.transformer)
  }

  disconnect() {
    return this.transport.disconnect()
  }
}
