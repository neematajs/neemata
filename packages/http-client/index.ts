import {
  ApiError,
  type AppClientInterface,
  BaseClient,
  type BaseClientFormat,
  type ResolveApiProcedureType,
} from '@neematajs/common'

import qs from 'qs'

export type ClientOptions = {
  host: string
  timeout: number
  secure?: boolean
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
  private isHealthy = false
  private attempts = 0

  constructor(private readonly options: ClientOptions) {
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
  }

  async connect() {
    await this.healthCheck()
  }

  async disconnect() {}

  async reconnect() {
    await this.disconnect()
    await this.connect()
  }

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

    return await fetch(this.getURL(`api/${procedure as string}`, 'http'), {
      signal: AbortSignal.timeout(timeout),
      method: 'POST',
      body: JSON.stringify(payload),
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
    return this.getURL(`api/${procedure as string}`, 'http', query)
  }

  private getURL(path = '', protocol: 'ws' | 'http', params = '') {
    const url = new URL(
      `${this.options.secure ? protocol + 's' : protocol}://${
        this.options.host
      }/${path}`,
    )
    url.search = params
    return url
  }
}