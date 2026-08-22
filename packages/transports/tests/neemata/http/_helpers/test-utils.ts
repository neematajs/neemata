import type { TransportWorkerParams } from '@nmtjs/gateway'
import type { Mock } from 'vitest'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'
import { vi } from 'vitest'

import type { NeemataHttpHandlerOptions } from '../../../../src/neemata/http/types.ts'
import { NeemataHttpHandler } from '../../../../src/neemata/http/server.ts'

export type TestParams = TransportWorkerParams<any>

export function createTestCodecs() {
  return new ProtocolCodecRegistry([new JsonCodec()])
}

export function createTestParams(
  onRpc: Mock = vi.fn(async () => ({ ok: true })),
) {
  const connection = {
    id: 'test-connection',
    [Symbol.asyncDispose]: async () => {},
  }
  const params = {
    onConnect: vi.fn(async () => connection),
    onDisconnect: vi.fn(async () => {}),
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
    createTestCodecs(),
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
