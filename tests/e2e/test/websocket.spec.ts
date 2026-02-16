import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { JsonFormat } from '@nmtjs/json-format/client'
import { MsgpackFormat } from '@nmtjs/msgpack-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  E2E_CWD,
  startNeemataCliServer,
  stopServerProcess,
} from './_utils/server.ts'

const contract = c.router({
  routes: {
    ping: c.procedure({
      input: t.object({}),
      output: t.object({ message: t.string() }),
    }),
    streamCount: c.procedure({
      input: t.object({ count: t.number() }),
      output: t.object({ index: t.number() }),
      stream: true,
    }),
  },
})

const CWD = E2E_CWD
const BASIC_CONFIG_PATH = resolve(CWD, 'src/basic/neemata.config.js')
const SERVER_HOST = DEFAULT_SERVER_HOST
const SERVER_PORT = DEFAULT_SERVER_PORT
const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`

function createWsClient(format: JsonFormat | MsgpackFormat) {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format },
    WsTransportFactory,
    { url: SERVER_URL },
  )
}

describe('Playground E2E - WebSocket Streaming', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startNeemataCliServer({
      command: 'preview',
      configPath: BASIC_CONFIG_PATH,
      timeoutMs: 15000,
      startupDelayMs: 1000,
      cwd: CWD,
      host: SERVER_HOST,
      port: SERVER_PORT,
    })
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServerProcess(serverProcess)
    }
  })

  it('calls ping procedure over WebSocket transport', async () => {
    const client = createWsClient(new JsonFormat())

    await client.connect()
    try {
      const result = await client.call.ping({})
      expect(result).toEqual({ message: 'pong' })
    } finally {
      await client.disconnect()
    }
  })

  it('streams values over WebSocket transport with JSON format', async () => {
    const client = createWsClient(new JsonFormat())
    const result: number[] = []

    await client.connect()
    try {
      for await (const chunk of await client.stream.streamCount({ count: 5 })) {
        result.push(chunk.index)
      }
    } finally {
      await client.disconnect()
    }

    expect(result).toEqual([0, 1, 2, 3, 4])
  })

  it('streams values over WebSocket transport with Msgpack format', async () => {
    const client = createWsClient(new MsgpackFormat())
    const result: number[] = []

    await client.connect()
    try {
      for await (const chunk of await client.stream.streamCount({ count: 5 })) {
        result.push(chunk.index)
      }
    } finally {
      await client.disconnect()
    }

    expect(result).toEqual([0, 1, 2, 3, 4])
  })
})
