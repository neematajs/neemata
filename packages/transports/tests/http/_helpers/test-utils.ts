import type { TransportWorkerParams } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import type { Mock } from 'vitest'
import { vi } from 'vitest'

import type { NeemataHttpHandlerOptions } from '../../../src/http/types.ts'
import { NeemataHttpHandler } from '../../../src/http/server.ts'

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

export async function createTestServer(
  options: Partial<NeemataHttpHandlerOptions>,
  params: TestParams,
  hostMaxRequestBodySize?: number,
) {
  return new NeemataHttpHandler(
    params as any,
    { path: '/', ...options },
    hostMaxRequestBodySize,
  )
}

export function createTestRequest(
  headers: Record<string, string>,
  body: BodyInit | null = null,
  method = 'POST',
  url = 'http://localhost/testProcedure',
) {
  const init: RequestInit & { duplex?: 'half' } = { headers, method }
  if (body !== null) {
    init.body = body
    init.duplex = 'half'
  }
  return new Request(url, init)
}
