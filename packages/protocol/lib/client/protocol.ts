import { type InteractivePromise, createPromise } from '@nmtjs/common'
import { concat, decodeNumber, encodeNumber } from '../common/binary.ts'
import type { ProtocolBlobMetadata } from '../common/blob.ts'
import { ClientMessageType, ServerMessageType } from '../common/enums.ts'
import type { ProtocolRPC } from '../common/types.ts'
import { EventEmitter } from './events.ts'
import type { BaseClientFormat } from './format.ts'
import {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
  ProtocolServerStream,
} from './stream.ts'

export class ProtocolError extends Error {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  get message() {
    return `${this.code} ${super.message}`
  }

  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    }
  }
}

export class ProtocolClientStreams {
  readonly #collection = new Map<number, ProtocolClientBlobStream>()

  get(streamId: number) {
    const stream = this.#collection.get(streamId)
    if (!stream) throw new Error('Stream not found')
    return stream
  }

  add(
    source: ReadableStream,
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) {
    const stream = new ProtocolClientBlobStream(source, streamId, metadata)
    this.#collection.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  abort(streamId: number) {
    const stream = this.get(streamId)
    stream.abort()
    this.remove(streamId)
  }

  pull(streamId: number, size: number) {
    const stream = this.get(streamId)
    return stream.read(size)
  }

  end(streamId: number) {
    const stream = this.get(streamId)
    stream.end()
    this.remove(streamId)
  }
}

export class ProtocolServerStreams {
  readonly #collection = new Map<number, ProtocolServerStream>()

  has(streamId: number) {
    return this.#collection.has(streamId)
  }

  get(streamId: number) {
    const stream = this.#collection.get(streamId)
    if (!stream) throw new Error('Stream not found')
    return stream
  }

  add(streamId: number, stream: ProtocolServerStream) {
    this.#collection.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  abort(streamId: number) {
    if (this.has(streamId)) {
      const stream = this.get(streamId)
      stream.abort()
      this.remove(streamId)
    }
  }

  async push(streamId: number, chunk: ArrayBuffer) {
    const stream = this.get(streamId)
    return await stream.push(chunk)
  }

  end(streamId: number) {
    const stream = this.get(streamId)
    stream.end()
    this.remove(streamId)
  }
}

export interface ProtocolTransport
  extends EventEmitter<{
    [K in `${ServerMessageType}`]: [ArrayBuffer]
  }> {
  connect(
    auth: any,
    contentType: BaseClientFormat['contentType'],
  ): Promise<void>
  disconnect(): Promise<void>
  send(messageType: ClientMessageType, buffer: ArrayBuffer): Promise<void>
}

export class ProtocolBaseTransformer {
  encodeRPC(namespace: string, procedure: string, payload: any) {
    return payload
  }
  decodeRPC(namespace: string, procedure: string, payload: any) {
    return payload
  }
  decodeRPCChunk(namespace: string, procedure: string, payload: any) {
    return payload
  }
  decodeEvent(namespace: string, event: string, payload: any) {
    return payload
  }
}

export type ProtocolClientCall = InteractivePromise<any> &
  Pick<ProtocolRPC, 'namespace' | 'procedure'>

export abstract class ProtocolBaseClient<
  T extends Record<string, Record<string, any>>,
> extends EventEmitter<
  {
    [N in keyof T]: {
      [E in keyof T[N] as `${Extract<N, string>}/${Extract<E, string>}`]: [
        payload: T[N][E],
      ]
    }
  }[keyof T]
> {
  readonly #clientStreams: ProtocolClientStreams
  readonly #serverStreams: ProtocolServerStreams
  readonly #serverRPCStreams: ProtocolServerStreams
  readonly #serverRPCStreamCalls = new Map<
    number,
    Pick<ProtocolRPC, 'namespace' | 'procedure'>
  >()
  readonly #calls = new Map<number, ProtocolClientCall>()

  #callId = 0
  #streamId = 0

  constructor(
    protected readonly transport: ProtocolTransport,
    protected readonly format: BaseClientFormat,
    protected readonly transformer: ProtocolBaseTransformer = new ProtocolBaseTransformer(),
  ) {
    super()

    this.#clientStreams = new ProtocolClientStreams()
    this.#serverStreams = new ProtocolServerStreams()
    this.#serverRPCStreams = new ProtocolServerStreams()

    this.transport.on(`${ServerMessageType.Event}`, (buffer) => {
      const [namespace, event, payload] = this.format.decode(buffer)
      const name = `${namespace}/${event}`
      const transformed = this.transformer.decodeEvent(
        namespace,
        event,
        payload,
      )
      this.emit(name, transformed)
    })

    this.transport.on(`${ServerMessageType.RpcResponse}`, (buffer) => {
      const { call, error, payload } = this.#handleResponse(buffer)
      if (error) call.reject(error)
      else call.resolve(payload)
    })

    this.transport.on(`${ServerMessageType.RpcStreamResponse}`, (buffer) => {
      const { call, response, payload, error } = this.#handleResponse(buffer)
      if (error) return call.reject(error)
      console.log('Creating RPC stream', response)
      const stream = new ProtocolServerStream()
      this.#serverRPCStreams.add(response.callId, stream)
      this.#serverRPCStreamCalls.set(response.callId, {
        namespace: call.namespace,
        procedure: call.procedure,
      })
      call.resolve([payload, stream])
    })

    this.transport.on(`${ServerMessageType.RpcStreamChunk}`, async (buffer) => {
      const callId = decodeNumber(buffer, 'Uint32')
      console.log('RPC stream chunk', callId)

      const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
      if (chunk.byteLength === 0) {
        this.#serverRPCStreams.end(callId)
        this.#serverRPCStreamCalls.delete(callId)
      } else {
        const call = this.#serverRPCStreamCalls.get(callId)
        console.log('RPC stream call', call)
        if (call) {
          const payload = this.format.decode(chunk)
          console.log('RPC stream payload', payload)
          try {
            const transformed = this.transformer.decodeRPCChunk(
              call.namespace,
              call.procedure,
              payload,
            )
            await this.#serverRPCStreams.push(callId, transformed)
          } catch (error) {
            this._send(
              ClientMessageType.RpcStreamAbort,
              encodeNumber(callId, 'Uint32'),
            )
            this.#serverRPCStreams.remove(callId)
            this.#serverRPCStreamCalls.delete(callId)
          }
        }
      }
    })

    this.transport.on(`${ServerMessageType.RpcStreamAbort}`, (buffer) => {
      const callId = decodeNumber(buffer, 'Uint32')
      console.log('RPC stream abort', callId)
      const call = this.#calls.get(callId)
      if (call) {
        this.#serverStreams.end(callId)
        this.#serverRPCStreams.abort(callId)
      }
    })

    this.transport.on(
      `${ServerMessageType.ServerStreamPush}`,
      async (buffer) => {
        const streamId = decodeNumber(buffer, 'Uint32')
        const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
        console.log('Server stream push', streamId, chunk.byteLength)
        try {
          await this.#serverStreams.push(streamId, chunk)
          this._send(
            ClientMessageType.ServerStreamPull,
            encodeNumber(streamId, 'Uint32'),
          )
        } catch (error) {
          this._send(
            ClientMessageType.ServerStreamAbort,
            encodeNumber(streamId, 'Uint32'),
          )
          this.#serverStreams.remove(streamId)
        }
      },
    )

    this.transport.on(`${ServerMessageType.ServerStreamEnd}`, (buffer) => {
      const streamId = decodeNumber(buffer, 'Uint32')
      console.log('Server stream end', streamId)
      this.#serverStreams.end(streamId)
    })

    this.transport.on(`${ServerMessageType.ServerStreamAbort}`, (buffer) => {
      const streamId = decodeNumber(buffer, 'Uint32')
      console.log('Server stream abort', streamId)
      this.#serverStreams.abort(streamId)
    })

    this.transport.on(`${ServerMessageType.ClientStreamAbort}`, (buffer) => {
      const streamId = decodeNumber(buffer, 'Uint32')
      console.log('Client stream abort', streamId)
      this.#clientStreams.abort(streamId)
    })

    this.transport.on(
      `${ServerMessageType.ClientStreamPull}`,
      async (buffer) => {
        const streamId = decodeNumber(buffer, 'Uint32')
        console.log('Client stream pull', streamId)
        const size = decodeNumber(
          buffer,
          'Uint32',
          Uint32Array.BYTES_PER_ELEMENT,
        )
        const streamIdEncoded = encodeNumber(streamId, 'Uint32')
        try {
          const chunk = await this.#clientStreams.pull(streamId, size)
          if (chunk) {
            this._send(
              ClientMessageType.ClientStreamPush,
              concat(streamIdEncoded, chunk),
            )
          } else {
            this._send(ClientMessageType.ClientStreamEnd, streamIdEncoded)
            this.#clientStreams.end(streamId)
          }
        } catch (error) {
          console.error(error)
          this._send(ClientMessageType.ClientStreamAbort, streamIdEncoded)
        }
      },
    )
  }

  async connect(auth: any) {
    return await this.transport.connect(auth, this.format.contentType)
  }

  async disconnect() {
    return await this.transport.disconnect()
  }

  protected async _send(messageType: ClientMessageType, buffer: ArrayBuffer) {
    console.log(
      'Client transport send',
      ClientMessageType[messageType],
      buffer.byteLength,
    )
    return await this.transport.send(messageType, buffer)
  }

  protected async _call(
    namespace: string,
    procedure: string,
    payload: any,
    options = {},
  ) {
    const callId = ++this.#callId
    const call = Object.assign(createPromise(), {
      namespace,
      procedure,
    })
    const buffer = this.format.encodeRPC(
      {
        callId,
        namespace,
        procedure,
        payload: this.transformer.encodeRPC(namespace, procedure, payload),
      },
      {
        addStream: (blob) => {
          const streamId = ++this.#streamId
          const stream = this.#clientStreams.add(
            blob.source,
            streamId,
            blob.metadata,
          )
          return stream
        },
        getStream: (id) => {
          const stream = this.#clientStreams.get(id)
          return stream
        },
      },
    )

    this.transport.send(ClientMessageType.Rpc, buffer).catch(console.error)

    this.#calls.set(callId, call)

    return call.promise
  }

  #handleResponse(buffer: ArrayBuffer) {
    const callStreams: ProtocolServerBlobStream[] = []
    const response = this.format.decodeRPC(buffer, {
      addStream: (id, metadata) => {
        console.log('Client transport blob stream', id, metadata)
        const stream = new ProtocolServerBlobStream(id, metadata, () => {
          this._send(
            ClientMessageType.ServerStreamPull,
            encodeNumber(id, 'Uint32'),
          )
        })
        callStreams.push(stream)
        this.#serverStreams.add(id, stream)
        return stream
      },
      getStream: (id) => {
        return this.#serverStreams.get(id)
      },
    })

    console.log('Client transport response', response)

    const call = this.#calls.get(response.callId)

    if (call) {
      this.#calls.delete(response.callId)

      if (response.error) {
        const error = new ProtocolError(
          response.error.code,
          response.error.message,
          response.error.data,
        )
        return { call, response, error }
      } else {
        const payload = this.transformer.decodeRPC(
          call.namespace,
          call.procedure,
          response.payload,
        )
        return { call, response, payload }
      }
    }

    for (const stream of callStreams) {
      this.#serverStreams.abort(stream.id)
    }

    throw new Error('Call not found')
  }
}
