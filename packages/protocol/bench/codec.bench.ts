import { Buffer } from 'node:buffer'

import { bench, describe } from 'vitest'

import type { MessageContext as ClientMessageContext } from '../src/client/protocol.ts'
import type { MessageContext as ServerMessageContext } from '../src/server/types.ts'
import { ProtocolVersion1 as ClientProtocolVersion1 } from '../src/client/versions/v1.ts'
import { ClientMessageType } from '../src/common/enums.ts'
import { JsonCodec as ClientJsonCodec } from '../src/json/client.ts'
import { JsonCodec as ServerJsonCodec } from '../src/json/server.ts'
import { MsgpackCodec as ClientMsgpackCodec } from '../src/msgpack/client.ts'
import { MsgpackCodec as ServerMsgpackCodec } from '../src/msgpack/server.ts'
import { ProtocolVersion1 as ServerProtocolVersion1 } from '../src/server/versions/v1.ts'

const BENCHMARK_OPTIONS = {
  time: 200,
  warmupTime: 50,
  iterations: 20,
  warmupIterations: 5,
} as const

const payload = Object.freeze({
  id: 'case-0001',
  revision: 17,
  active: true,
  tags: ['triage', 'cardiology', 'reviewed'],
  patient: {
    age: 48,
    observations: Array.from({ length: 16 }, (_, index) => ({
      code: `observation-${index.toString().padStart(2, '0')}`,
      value: index * 3,
      unit: 'mg/dL',
    })),
  },
})

const clientJsonCodec = new ClientJsonCodec()
const clientMsgpackCodec = new ClientMsgpackCodec()
const jsonBuffer = clientJsonCodec.encode(payload)
const msgpackBuffer = clientMsgpackCodec.encode(payload)

const clientProtocol = new ClientProtocolVersion1()
const serverProtocol = new ServerProtocolVersion1()

const createClientContext = (
  codec: ClientJsonCodec | ClientMsgpackCodec,
): ClientMessageContext => ({
  decoder: codec,
  encoder: codec,
  addClientStream: () => {
    throw new Error('The deterministic benchmark payload has no streams')
  },
  addServerStream: () => {
    throw new Error('The deterministic benchmark payload has no streams')
  },
  transport: { send: () => undefined },
  streamId: () => 1,
})

const createServerContext = (
  codec: ServerJsonCodec | ServerMsgpackCodec,
): ServerMessageContext => ({
  protocol: serverProtocol,
  connectionId: 'benchmark-connection',
  streamId: () => 1,
  decoder: codec,
  encoder: codec,
  addClientStream: () => {
    throw new Error('The deterministic benchmark payload has no streams')
  },
  transport: {},
})

const rpcPayload = Object.freeze({
  callId: 42,
  procedure: 'cases/get',
  payload,
})
const clientJsonContext = createClientContext(clientJsonCodec)
const clientMsgpackContext = createClientContext(clientMsgpackCodec)
const serverJsonContext = createServerContext(new ServerJsonCodec())
const serverMsgpackContext = createServerContext(new ServerMsgpackCodec())
const jsonFrame = Buffer.from(
  clientProtocol.encodeMessage(
    clientJsonContext,
    ClientMessageType.Rpc,
    rpcPayload,
  ),
)
const msgpackFrame = Buffer.from(
  clientProtocol.encodeMessage(
    clientMsgpackContext,
    ClientMessageType.Rpc,
    rpcPayload,
  ),
)

describe('protocol payload codecs', () => {
  bench(
    'JSON encode',
    () => {
      clientJsonCodec.encode(payload)
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'MessagePack encode',
    () => {
      clientMsgpackCodec.encode(payload)
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'JSON decode',
    () => {
      clientJsonCodec.decode(jsonBuffer)
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'MessagePack decode',
    () => {
      clientMsgpackCodec.decode(msgpackBuffer)
    },
    BENCHMARK_OPTIONS,
  )
})

describe('protocol RPC frames', () => {
  bench(
    'JSON encode frame',
    () => {
      clientProtocol.encodeMessage(
        clientJsonContext,
        ClientMessageType.Rpc,
        rpcPayload,
      )
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'MessagePack encode frame',
    () => {
      clientProtocol.encodeMessage(
        clientMsgpackContext,
        ClientMessageType.Rpc,
        rpcPayload,
      )
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'JSON decode frame',
    () => {
      serverProtocol.decodeMessage(serverJsonContext, jsonFrame)
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'MessagePack decode frame',
    () => {
      serverProtocol.decodeMessage(serverMsgpackContext, msgpackFrame)
    },
    BENCHMARK_OPTIONS,
  )
})
