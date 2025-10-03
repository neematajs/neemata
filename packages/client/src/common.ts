import type { TAnyAPIContract } from '@nmtjs/contract'
import type {
  ProtocolBaseClientCallOptions,
  ProtocolBaseTransformer,
  ProtocolTransport,
} from '@nmtjs/protocol/client'
import { noopFn } from '@nmtjs/common'
import { EventEmitter, ProtocolError } from '@nmtjs/protocol/client'

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

const DEFAULT_RECONNECT_TIMEOUT = 1000

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
  _!: { api: API; safe: SafeCall }

  protected abstract transformer: ProtocolBaseTransformer
  protected callers!: ClientCallers<API, SafeCall>
  protected auth: any
  protected reconnectTimeout: number = DEFAULT_RECONNECT_TIMEOUT

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
      this.transport.on('disconnected', async (reason) => {
        if (reason === 'server') {
          this.connect()
        } else if (reason === 'error') {
          const timeout = new Promise((resolve) =>
            setTimeout(resolve, this.reconnectTimeout),
          )
          const connected = new Promise((_, reject) =>
            this.transport.once('connected', reject),
          )
          this.reconnectTimeout += DEFAULT_RECONNECT_TIMEOUT
          await Promise.race([timeout, connected]).then(
            this.connect.bind(this),
            noopFn,
          )
        }
      })
      this.transport.on('connected', () => {
        this.reconnectTimeout = DEFAULT_RECONNECT_TIMEOUT
      })
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
