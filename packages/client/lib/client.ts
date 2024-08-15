import { type BaseClientFormat, ErrorCode } from '@nmtjs/common'

import { ClientError } from './common.ts'
import type { ClientTransport } from './transport.ts'
import type { ClientCallOptions } from './types.ts'
import * as utils from './utils.ts'

export type ClientOptions = {
  defaultTimeout: number
  debug?: boolean
}

export abstract class Client extends utils.EventEmitter {
  protected transport!: ClientTransport
  protected format!: BaseClientFormat

  auth?: string

  private ids = {
    call: 0,
    stream: 0,
  }

  constructor(
    protected readonly options: ClientOptions,
    protected services: string[],
  ) {
    super()
    if (!options.defaultTimeout) options.defaultTimeout = 15000
  }

  useTransport<T extends new (...args: any[]) => ClientTransport>(
    transportClass: T,
    ...options: ConstructorParameters<T>
  ) {
    this.transport = new transportClass(...options)
    this.transport.client = Object.freeze({
      services: this.services,
      format: this.format,
      auth: this.auth,
    })
    return this as Omit<this, 'useTransport'>
  }

  useFormat(format: BaseClientFormat) {
    this.format = format
    return this as Omit<this, 'useFormat'>
  }

  async connect() {
    await this.transport.connect()
  }

  async disconnect() {
    await this.transport.disconnect()
  }

  async reconnect() {
    await this.disconnect()
    await this.connect()
  }

  protected createCaller(
    service: string,
    procedure: string,
    {
      timeout = this.options.defaultTimeout,
      transformInput,
      transformOutput,
    }: {
      timeout?: number
      transformInput?: (input: any) => any
      transformOutput?: (output: any) => any
    } = {},
  ) {
    return async (payload: any, options: ClientCallOptions = {}) => {
      const { signal } = options

      const abortSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout)

      const callId = ++this.ids.call

      if (this.options.debug) {
        console.groupCollapsed(`RPC [${callId}] ${service}/${procedure}`)
        console.log(payload)
        console.groupEnd()
      }

      const callExecution = this.transport
        .rpc({
          callId,
          service,
          procedure,
          payload: transformInput ? transformInput(payload) : payload,
          signal: abortSignal,
        })
        .then((result) => {
          if (result.success) return result.value
          throw new ClientError(
            result.error.code,
            result.error.message,
            result.error.data,
          )
        })

      const callTimeout = utils.forAborted(abortSignal).catch(() => {
        const error = new ClientError(ErrorCode.RequestTimeout)
        return Promise.reject(error)
      })

      try {
        const response = await Promise.race([callTimeout, callExecution])

        if (this.options.debug) {
          console.groupCollapsed(`RPC [${callId}] Success`)
          console.log(response)
          console.groupEnd()
        }

        return transformOutput ? transformOutput(response) : response
      } catch (error) {
        if (this.options.debug) {
          console.groupCollapsed(`RPC [${callId}] Error`)
          console.log(error)
          console.groupEnd()
        }

        throw error
      }
    }
  }
}
