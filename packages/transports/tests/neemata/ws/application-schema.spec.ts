import { Buffer } from 'node:buffer'

import type { ApplicationResolvedProcedure } from '@nmtjs/application'
import type { TransportWorkerParams } from '@nmtjs/gateway'
import {
  ApplicationApi,
  createProcedure,
  createStream,
} from '@nmtjs/application'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '@nmtjs/protocol'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { MsgpackCodec } from '@nmtjs/protocol/msgpack/server'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import { WsSessionEngine } from '../../../src/neemata/ws/session.ts'

describe('ApplicationApi through Gateway with real codecs', () => {
  it.each([
    ['JSON', () => new JsonCodec()],
    ['MessagePack', () => new MsgpackCodec()],
  ] as const)(
    'preserves unary values and rejects undefined stream chunks with %s',
    async (_name, createFormat) => {
      const format = createFormat()
      const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
      const api = new ApplicationApi({
        logger,
        container: new Container({ logger }),
        procedures: new Map([
          [
            'test',
            {
              path: [],
              procedure: createProcedure({
                input: t.any(),
                handler: (_ctx, value) => value,
              }),
            },
          ],
        ]),
        meta: [],
        guards: new Set(),
        middlewares: new Set(),
        filters: new Set(),
      })
      api.options.procedures.set('stream', {
        path: [],
        procedure: createStream({
          async *handler() {
            yield 0
            yield false
            yield ''
            yield null
            yield undefined
          },
        }),
      })
      let transportParams:
        | TransportWorkerParams<ApplicationResolvedProcedure>
        | undefined
      const sent: Buffer[] = []
      const gateway = new Gateway({
        logger,
        container: api.options.container,
        hooks: new Hooks(),
        transports: {
          test: {
            transport: {
              start(params) {
                transportParams = params
                return 'test://'
              },
              stop() {},
            },
          },
        },
        api,
      })
      await gateway.start()
      try {
        if (!transportParams) throw new Error('Transport did not start')
        const params = transportParams
        const connection = await params.onConnect({ data: {} })
        const engine = new WsSessionEngine(params, {
          heartbeat: false,
          send(_connectionId, data) {
            sent.push(
              Buffer.from(data.buffer, data.byteOffset, data.byteLength),
            )
            return 'delivered'
          },
          async terminate(connectionId) {
            engine.close(connectionId)
            await params.onDisconnect(connectionId)
          },
        })
        engine.open(connection, {
          protocolVersion: ProtocolVersion.v1,
          encoder: format,
          decoder: format,
        })
        const request = (callId: number, procedure: string, value: unknown) => {
          const name = Buffer.from(procedure)
          const header = Buffer.alloc(7)
          header.writeUInt8(ClientMessageType.Rpc, 0)
          header.writeUInt32LE(callId, 1)
          header.writeUInt16LE(name.byteLength, 5)
          const payload = format.encodeRPC(value, {})
          return Uint8Array.from(
            Buffer.concat([header, name, Buffer.from(payload)]),
          ).buffer
        }
        let callId = 1
        for (const value of [undefined, null, false, 0, '', { ok: true }]) {
          sent.length = 0
          await engine.receive(connection.id, request(callId++, 'test', value))
          expect(sent).toHaveLength(1)
          expect(sent[0].readUInt8(0)).toBe(ServerMessageType.RpcResponse)
          expect(sent[0].readUInt8(5)).toBe(0)
          expect(
            format.decodeRPC(sent[0].subarray(6), {
              addStream() {
                throw new Error('Unexpected blob')
              },
            }),
          ).toEqual(value)
          await expect(
            params.onRpc(
              connection,
              { procedure: 'test', payload: value },
              new AbortController().signal,
            ),
          ).resolves.toEqual(value)
        }

        sent.length = 0
        const streamCallId = callId++
        const running = engine.receive(
          connection.id,
          request(streamCallId, 'stream', undefined),
        )
        await vi.waitFor(() =>
          expect(sent[0]?.readUInt8(0)).toBe(
            ServerMessageType.RpcStreamResponse,
          ),
        )
        const pull = Buffer.alloc(9)
        pull.writeUInt8(ClientMessageType.RpcStreamPull, 0)
        pull.writeUInt32LE(streamCallId, 1)
        pull.writeUInt32LE(6, 5)
        await engine.receive(connection.id, pull)
        await running
        const chunks = sent.filter(
          (message) =>
            message.readUInt8(0) === ServerMessageType.RpcStreamChunk,
        )
        expect(
          chunks.map((message) => format.decode(message.subarray(5))),
        ).toEqual([0, false, '', null])
        expect(sent.at(-1)?.readUInt8(0)).toBe(ServerMessageType.RpcStreamAbort)
        expect(engine.rpcs.get(connection.id, streamCallId)).toBeUndefined()
        engine.close(connection.id)
        await connection[Symbol.asyncDispose]()
      } finally {
        await gateway.stop()
      }
    },
  )
})
