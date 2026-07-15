import type { TransportWorkerParams } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import type { Mock } from 'vitest'
import { vi } from 'vitest'

import type {
  HttpAdapterServerFactory,
  HttpTransportOptions,
} from '../../src/types.ts'
import { HttpTransportServer } from '../../src/server.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type TestParams = TransportWorkerParams<
  ConnectionType.Unidirectional,
  any
>

export function createTestParams(
  onRpc: Mock = vi.fn(async () => ({ ok: true })),
) {
  const connection = {
    id: 'test-connection',
    encoder: {
      contentType: 'application/json',
      encode: (data: unknown) =>
        textEncoder.encode(JSON.stringify(data ?? null)),
    },
    decoder: {
      decode: (buffer: Uint8Array) => JSON.parse(textDecoder.decode(buffer)),
    },
    [Symbol.asyncDispose]: async () => {},
  }
  const params = {
    formats: {
      supportsDecoder: (contentType: string) =>
        contentType.startsWith('application/json'),
    },
    onConnect: vi.fn(async () => connection),
    onDisconnect: vi.fn(async () => {}),
    onMessage: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({ meta: new Map() })),
    onRpc,
  } as unknown as TestParams
  return { params, onRpc, connection }
}

const stubAdapterFactory: HttpAdapterServerFactory<any> = () => ({
  runtime: {},
  start: () => 'http://127.0.0.1:0',
  stop: () => {},
})

export async function createTestServer(
  options: Partial<HttpTransportOptions>,
  params: TestParams,
) {
  const server = new HttpTransportServer(stubAdapterFactory, {
    listen: { port: 0 },
    ...options,
  })
  await server.start(params)
  return server
}

export function createTestRequest(
  headers: Record<string, string>,
  method = 'POST',
  url = 'http://localhost/testProcedure',
) {
  return { url: new URL(url), method, headers: new Headers(headers) }
}
