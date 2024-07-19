import { ErrorCode, type StreamMetadata } from '@neematajs/common'
import type { TServiceContract } from '@neematajs/contract'

import { ClientError } from './common.ts'
import { UpStream } from './stream.ts'
import type { ClientTransport } from './transport.ts'
import type {
  ClientCallOptions,
  ClientCallers,
  ClientServices,
} from './types.ts'
import * as utils from './utils.ts'

export class Client<Services extends ClientServices> {
  #callers: ClientCallers<Services>
  #ids = {
    call: 0,
    stream: 0,
  }

  constructor(
    protected readonly services: Services,
    protected readonly options: {
      defaultTimeout: number
      debug?: boolean
    },
    protected readonly transport: ClientTransport,
  ) {
    if (!options.defaultTimeout) options.defaultTimeout = 15000

    this.#callers = {} as any
    for (const [serviceKey, serviceContract] of Object.entries(services)) {
      // @ts-ignore
      this.#callers[serviceKey] = {} as any
      for (const procedureName in serviceContract.procedures) {
        // @ts-ignore
        this.#callers[serviceKey][procedureName] = this.#createCaller(
          serviceContract,
          procedureName,
        )
      }
    }
  }

  get call() {
    return this.#callers
  }

  stream(
    source: ArrayBuffer | ReadableStream | Blob,
    metadata: Partial<StreamMetadata> = {},
  ) {
    const streamId = ++this.#ids.stream
    metadata.size =
      metadata.size ??
      (source instanceof Blob
        ? source.size
        : source instanceof ArrayBuffer
          ? source.byteLength
          : undefined)
    metadata.type =
      metadata.type ?? (source instanceof Blob ? source.type : undefined)

    if (!metadata.size) throw new Error('Stream size is not provided')
    if (!metadata.type) throw new Error('Stream type is not provided')

    return new UpStream(streamId, metadata as StreamMetadata, source)
  }

  async connect() {
    const services = Object.values(this.services).map((service) => service.name)
    await this.transport.connect({ services })
  }

  async disconnect() {
    await this.transport.disconnect()
  }

  async reconnect() {
    await this.disconnect()
    await this.connect()
  }

  #createCaller(service: TServiceContract, procedure: string) {
    return async (payload: any, options: ClientCallOptions = {}) => {
      const { signal } = options

      if (this.transport.type in service.transports === false)
        throw new Error('Transport not supported')

      const { timeout = this.options.defaultTimeout } = service
      const abortSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout)

      const callId = ++this.#ids.call

      if (this.options.debug) {
        console.groupCollapsed()
        console.log(`RPC [${callId}] ${service.name}/${procedure}`, payload)
        console.groupEnd()
      }

      const callExecution = this.transport
        .rpc({
          callId,
          service: service.name,
          procedure,
          payload,
          abortSignal,
        })
        .then((result) => {
          if (result.success) return result.value
          throw new ClientError(
            result.error.code,
            result.error.message,
            result.error.data,
          )
        })

      const callTimeout = utils.forAbort(abortSignal).catch(() => {
        const error = new ClientError(ErrorCode.RequestTimeout)
        return Promise.reject(error)
      })

      try {
        const response = await Promise.race([callTimeout, callExecution])

        if (this.options.debug) {
          console.groupCollapsed()
          console.log(`RPC [${callId}] Success`, response)
          console.groupEnd()
        }

        return response
      } catch (error) {
        if (this.options.debug) {
          console.groupCollapsed()
          console.log(`RPC [${callId}] Error`, error)
          console.groupEnd()
        }
        throw error
      }
    }
  }
}
