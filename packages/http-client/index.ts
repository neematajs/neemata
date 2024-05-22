import {
  ApiError,
  type AppClientInterface,
  BaseClient,
  type BaseClientFormat,
  type ResolveApiProcedureType,
} from '@neematajs/common'

import qs from 'qs'

export type ClientOptions = {
  origin: string
  timeout: number
  debug?: boolean
  format: BaseClientFormat
  WebSocket?: new (...args: any[]) => WebSocket
}

export type HttpRpcOptions = {
  timeout?: number
  headers?: Record<string, string>
}

export class HttpClient<
  AppClient extends AppClientInterface,
> extends BaseClient<AppClient, HttpRpcOptions> {
  private attempts = 0

  constructor(private readonly options: ClientOptions) {
    super()
  }

  async healthCheck() {
    while (true) {
      try {
        const signal = AbortSignal.timeout(10000)
        const url = this.getURL('healthy')
        const { ok } = await fetch(url, { signal })
        if (ok) break
      } catch (e) {}
      this.attempts++
      const seconds = Math.min(this.attempts, 15)
      await new Promise((r) => setTimeout(r, seconds * 1000))
    }
  }

  async connect() {
    await this.healthCheck()
  }

  async disconnect() {}

  async reconnect() {}

  async rpc<P extends keyof AppClient['procedures']>(
    procedure: P,
    ...args: AppClient['procedures'] extends never
      ? [any?, HttpRpcOptions?]
      : null extends ResolveApiProcedureType<
            AppClient['procedures'],
            P,
            'input'
          >
        ? [
            ResolveApiProcedureType<AppClient['procedures'], P, 'input'>?,
            HttpRpcOptions?,
          ]
        : [
            ResolveApiProcedureType<AppClient['procedures'], P, 'input'>,
            HttpRpcOptions?,
          ]
  ): Promise<
    AppClient['procedures'] extends never
      ? any
      : ResolveApiProcedureType<AppClient['procedures'], P, 'output'>
  > {
    const [payload, options = {}] = args
    const { timeout = options.timeout ?? this.options.timeout, headers = {} } =
      options

    return await fetch(this.getURL(`api/${procedure as string}`), {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      body: this.options.format.encode(payload),
      credentials: 'include',
      cache: 'no-cache',
      headers: {
        ...headers,
        'Content-Type': this.options.format.mime,
        Accept: this.options.format.mime,
      },
    })
      .then((res) => res.arrayBuffer())
      .then((buffer) => this.options.format.decode(buffer))
      .then(({ response, error }) => {
        if (error) throw new ApiError(error.code, error.message, error.data)
        return response
      })
  }

  url<P extends keyof AppClient['procedures']>(
    procedure: P,
    ...args: AppClient['procedures'] extends never
      ? [any?, HttpRpcOptions?]
      : null extends ResolveApiProcedureType<
            AppClient['procedures'],
            P,
            'input'
          >
        ? [
            ResolveApiProcedureType<AppClient['procedures'], P, 'input'>?,
            HttpRpcOptions?,
          ]
        : [
            ResolveApiProcedureType<AppClient['procedures'], P, 'input'>,
            HttpRpcOptions?,
          ]
  ): URL {
    const [payload] = args
    const query = qs.stringify(payload)
    return this.getURL(`api/${procedure as string}`, query)
  }

  private getURL(path = '', params = '') {
    const url = new URL(path, this.options.origin)
    url.search = params
    return url
  }
}
