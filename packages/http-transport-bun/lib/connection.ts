import { BaseTransportConnection, type Registry } from '@neematajs/application'

import type { HttpTransportData } from './types'

export class HttpConnection extends BaseTransportConnection {
  readonly transport = 'http'

  constructor(
    protected readonly registry: Registry,
    readonly data: HttpTransportData,
    private readonly headers: Headers,
  ) {
    super(registry)
  }

  protected sendEvent(): boolean {
    throw new Error(
      'HTTP transport does not support bi-directional communication',
    )
  }

  setHeader(key: string, value: string) {
    this.headers.set(key, value)
  }
}
