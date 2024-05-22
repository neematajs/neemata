import {
  AbortStreamError,
  ApiError,
  type AppClientInterface,
  BaseClient,
  type BaseClientFormat,
  type Call,
  DownStream,
  ErrorCode,
  MessageType,
  type ResolveApiProcedureType,
  StreamDataType,
  Subscription,
  concat,
  decodeNumber,
  decodeText,
  encodeNumber,
  encodeText,
  once,
} from '@neematajs/common'

export type ClintOptions = {
  origin: string
  timeout: number
  autoreconnect?: boolean
  debug?: boolean
  format: BaseClientFormat
  WebSocket?: new (...args: any[]) => WebSocket
}

type WsRpcOptions = {
  timeout?: number
}

export class WebsocketsClient<
  AppClient extends AppClientInterface = any,
> extends BaseClient<AppClient, WsRpcOptions> {
  private ws!: WebSocket
  private autoreconnect!: boolean
  private isHealthy = false
  private isConnected = false
  private attempts = 0
  private callId = 0
  private calls = new Map<number, Call>()
  private subscriptions = new Map<string, Subscription>()

  constructor(private readonly options: ClintOptions) {
    super()
  }

  async healthCheck() {
    while (!this.isHealthy) {
      try {
        const signal = AbortSignal.timeout(10000)
        const url = this.getURL('healthy', 'http')
        const { ok } = await fetch(url, { signal })
        this.isHealthy = ok
      } catch (e) {}

      if (!this.isHealthy) {
        this.attempts++
        const seconds = Math.min(this.attempts, 15)
        await new Promise((r) => setTimeout(r, seconds * 1000))
      }
    }
    this.emit('_neemata:healthy')
  }

  async connect() {
    this.autoreconnect = this.options.autoreconnect ?? true // reset default autoreconnect value
    await this.healthCheck()

    this.ws = new (this.options.WebSocket ?? globalThis.WebSocket)(
      this.getURL('api', 'ws'),
    )

    this.ws.binaryType = 'arraybuffer'

    this.ws.onmessage = (event) => {
      const buffer: ArrayBuffer = event.data
      const type = decodeNumber(buffer, 'Uint8')
      const handler = this[type]
      if (handler) {
        handler.call(this, buffer.slice(Uint8Array.BYTES_PER_ELEMENT), this.ws)
      }
    }
    this.ws.onopen = (event) => {
      this.isConnected = true
      this.emit('_neemata:open')
      this.attempts = 0
    }
    this.ws.onclose = (event) => {
      this.isConnected = false
      this.isHealthy = false
      this.emit('_neemata:close')
      this.clear(
        event.code === 1000
          ? undefined
          : new Error(
              `Connection closed with code ${event.code}: ${event.reason}`,
            ),
      )
      if (this.autoreconnect) this.connect()
    }
    this.ws.onerror = (event) => {
      this.isHealthy = false
    }
    await once(this, '_neemata:open')
    this.emit('_neemata:connect')
  }

  async disconnect() {
    this.autoreconnect = false
    const closing = once(this, '_neemata:close')
    this.ws?.close(1000)
    await closing
  }

  async reconnect() {
    await this.disconnect()
    await this.connect()
  }

  async rpc<P extends keyof AppClient['procedures']>(
    procedure: P,
    ...args: AppClient['procedures'] extends never
      ? [any?, WsRpcOptions?]
      : null extends ResolveApiProcedureType<
            AppClient['procedures'],
            P,
            'input'
          >
        ? [
            ResolveApiProcedureType<AppClient['procedures'], P, 'input'>?,
            WsRpcOptions?,
          ]
        : [
            ResolveApiProcedureType<AppClient['procedures'], P, 'input'>,
            WsRpcOptions?,
          ]
  ): Promise<
    AppClient['procedures'] extends never
      ? any
      : ResolveApiProcedureType<AppClient['procedures'], P, 'output'>
  > {
    const [payload, options = {}] = args
    const { timeout = options.timeout ?? this.options.timeout } = options
    const callId = ++this.callId
    const data = this.options.format.encodeRpc(
      callId,
      procedure as string,
      payload,
    )

    const timer = setTimeout(() => {
      const call = this.calls.get(callId)
      if (call) {
        const { reject } = call
        reject(new ApiError(ErrorCode.RequestTimeout, 'Request timeout'))
        this.calls.delete(callId)
      }
    }, timeout)

    if (!this.isConnected) await once(this, '_neemata:connect')

    return new Promise((resolve, reject) => {
      this.calls.set(callId, { resolve, reject, timer })
      this.send(MessageType.Rpc, data)
    })
  }

  private getURL(path = '', protocol: 'ws' | 'http', params = '') {
    const base = new URL(origin)
    const secure = base.protocol === 'https:'
    const url = new URL(
      `${secure ? protocol + 's' : protocol}://${base.host}/${path}`,
    )
    url.search = params
    return url
  }

  private async clear(error?: Error) {
    for (const call of this.calls.values()) {
      const { reject, timer } = call
      if (timer) clearTimeout(timer)
      reject(error)
    }

    for (const stream of this.streams.up.values()) {
      stream.destroy(error)
    }

    for (const stream of this.streams.down.values()) {
      stream.ac.abort(error)
    }

    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe()
    }

    this.calls.clear()
    this.streams.up.clear()
    this.streams.down.clear()
    this.subscriptions.clear()
  }

  private async send(type: MessageType, ...payload: ArrayBuffer[]) {
    this.ws.send(concat(encodeNumber(type, 'Uint8'), ...payload))
  }

  protected [MessageType.Event](buffer: ArrayBuffer) {
    const [event, payload] = this.options.format.decode(buffer)
    this.emit(event, payload)
  }

  protected [MessageType.Rpc](buffer: ArrayBuffer) {
    const [callId, response, error] = this.options.format.decode(buffer)
    const call = this.calls.get(callId)
    if (call) {
      const { resolve, reject, timer } = call
      if (timer) clearTimeout(timer)
      this.calls.delete(callId)
      if (error) reject(new ApiError(error.code, error.message, error.data))
      else resolve(response)
    }
  }

  protected [MessageType.RpcStream](buffer: ArrayBuffer) {
    const [callId, streamDataType, streamId, payload] =
      this.options.format.decode(buffer)
    const call = this.calls.get(callId)
    if (call) {
      const ac = new AbortController()
      ac.signal.addEventListener(
        'abort',
        () => {
          this.streams.down.delete(streamId)
          this.send(
            MessageType.ServerStreamAbort,
            encodeNumber(streamId, 'Uint32'),
          )
        },
        { once: true },
      )
      const transformer = transformers[streamDataType].bind(
        null,
        this.options.format,
      )
      const stream = new DownStream(transformer, ac)
      this.streams.down.set(streamId, stream)
      const { resolve, timer } = call
      if (timer) clearTimeout(timer)
      this.calls.delete(callId)
      resolve({ payload, stream: stream.interface })
    } else {
      this.send(MessageType.ServerStreamAbort, encodeNumber(streamId, 'Uint32'))
    }
  }

  protected [MessageType.RpcSubscription](buffer: ArrayBuffer) {
    const [callId, key] = this.options.format.decode(buffer)
    const call = this.calls.get(callId)
    if (call) {
      const { resolve, timer } = call
      if (timer) clearTimeout(timer)
      this.calls.delete(callId)
      const subscription = new Subscription(key, () => {
        subscription.emit('end')
        this.subscriptions.delete(key)
        this.send(
          MessageType.ClientUnsubscribe,
          encodeText(JSON.stringify([key])),
        )
      })
      this.subscriptions.set(key, subscription)
      resolve(subscription)
    }
  }

  protected async [MessageType.ClientStreamPull](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const size = decodeNumber(buffer, 'Uint32', Uint32Array.BYTES_PER_ELEMENT)
    const stream = this.streams.up.get(id)
    if (!stream) throw new Error('Stream not found')
    const { done, chunk } = await stream._read(size)
    if (done) {
      this.send(MessageType.ClientStreamEnd, encodeNumber(id, 'Uint32'))
    } else {
      this.send(
        MessageType.ClientStreamPush,
        concat(encodeNumber(id, 'Uint32'), chunk!),
      )
    }
  }

  protected async [MessageType.ClientStreamEnd](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = this.streams.up.get(id)
    if (!stream) throw new Error('Stream not found')
    stream._finish()
    this.streams.up.delete(id)
  }

  protected [MessageType.ClientStreamAbort](buffer: ArrayBuffer) {
    const id = decodeNumber(buffer, 'Uint32')
    const stream = this.streams.up.get(id)
    if (!stream) throw new Error('Stream not found')
    stream.destroy(new AbortStreamError('Aborted by server'))
    this.streams.up.delete(id)
  }

  protected async [MessageType.ServerStreamPush](buffer: ArrayBuffer) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const stream = this.streams.down.get(streamId)
    if (stream) {
      await stream.writer.write(
        new Uint8Array(buffer.slice(Uint32Array.BYTES_PER_ELEMENT)),
      )
      this.send(MessageType.ServerStreamPull, encodeNumber(streamId, 'Uint32'))
    }
  }

  protected [MessageType.ServerStreamEnd](buffer: ArrayBuffer) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const stream = this.streams.down.get(streamId)
    if (stream) stream.writer.close()
    this.streams.down.delete(streamId)
  }

  protected [MessageType.ServerStreamAbort](buffer: ArrayBuffer) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const stream = this.streams.down.get(streamId)
    if (stream) stream.writable.abort(new AbortStreamError('Aborted by server'))
    this.streams.down.delete(streamId)
  }

  protected [MessageType.ServerSubscriptionEmit](buffer: ArrayBuffer) {
    const [key, payload] = this.options.format.decode(buffer)
    const subscription = this.subscriptions.get(key)
    if (subscription) subscription.emit('data', payload)
  }

  protected [MessageType.ServerUnsubscribe](buffer: ArrayBuffer) {
    const [key] = this.options.format.decode(buffer)
    const subscription = this.subscriptions.get(key)
    subscription?.emit('end')
    this.subscriptions.delete(key)
  }
}

const transformers: Record<
  StreamDataType,
  (
    ...args: [
      BaseClientFormat,
      ...Parameters<TransformerTransformCallback<any, any>>,
    ]
  ) => ReturnType<TransformerTransformCallback<any, any>>
> = {
  [StreamDataType.Encoded]: (format, chunk, controller) =>
    controller.enqueue(format.decode(chunk)),
  [StreamDataType.Binary]: (format, chunk, controller) =>
    controller.enqueue(chunk),
} as const
