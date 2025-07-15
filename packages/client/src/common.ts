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

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  TransportType,
} from '@nmtjs/protocol'
export * from './types.ts'

export class ClientError extends ProtocolError {}

export abstract class BaseClient<
  APIContract extends TAnyAPIContract = TAnyAPIContract,
  SafeCall extends boolean = false,
  API extends ResolveAPIContract<
    APIContract,
    RuntimeInputContractTypeProvider,
    RuntimeOutputContractTypeProvider
  > = ResolveAPIContract<
    APIContract,
    RuntimeInputContractTypeProvider,
    RuntimeOutputContractTypeProvider
  >,
> extends EventEmitter<ResolveClientEvents<API>> {
  _!: {
    api: API
    safe: SafeCall
  }

  protected abstract transformer: ProtocolBaseTransformer
  protected callers!: ClientCallers<API, SafeCall>
  protected auth: any

  constructor(
    readonly transport: ProtocolTransport,
    readonly options: {
      timeout: number
      autoreconnect?: boolean
      safe?: SafeCall
    },
  ) {
    super()

    if (this.options.autoreconnect) {
      this.transport.on('disconnected', () =>
        setTimeout(this.connect.bind(this), 1000),
      )
    }
  }

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
