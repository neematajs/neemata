import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { JsonFormat } from '@nmtjs/json-format/client'
import { MsgpackFormat } from '@nmtjs/msgpack-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
    streamBlob: c.procedure({
      input: t.object({ file: c.blob() }),
      output: t.object({ chunk: t.string() }),
      stream: true,
    }),
    uploadBlob: c.procedure({
      input: t.object({ file: c.blob() }),
      output: t.object({
        size: t.number(),
        content: t.string(),
        type: t.string(),
        filename: t.string().optional(),
      }),
    }),
    downloadBlob: c.procedure({
      input: t.object({ content: t.string(), filename: t.string().optional() }),
      output: c.blob(),
    }),
  },
})

const CWD = resolve(import.meta.dirname, '..')
const BASIC_CONFIG_PATH = resolve(CWD, 'src/basic/neemata.config.js')
const SERVER_HOST = '127.0.0.1'
const SERVER_PORT = 4000
const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`

async function startServer(
  command: 'preview',
  options: { timeout?: number } = {},
) {
  const timeout = options.timeout ?? 15000
  const canConnect = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host: SERVER_HOST, port: SERVER_PORT })
      const cleanup = () => {
        socket.removeAllListeners()
        socket.destroy()
      }

      socket.setTimeout(500)
      socket.once('connect', () => {
        cleanup()
        resolve(true)
      })
      socket.once('timeout', () => {
        cleanup()
        resolve(false)
      })
      socket.once('error', () => {
        cleanup()
        resolve(false)
      })
    })

  const serverProcess = spawn(
    'pnpm',
    ['exec', 'neemata', command, '--config', BASIC_CONFIG_PATH],
    {
      cwd: CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform === 'linux',
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  )

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    const timeoutId = globalThis.setTimeout(() => {
      finish(new Error(`Server startup timeout (${command})`))
    }, timeout)

    const readinessInterval = globalThis.setInterval(() => {
      canConnect().then((ready) => {
        if (ready) finish()
      })
    }, 250)

    const onError = (err: Error) => finish(err)
    const onExit = (code: number | null) => {
      finish(new Error(`Server exited before readiness (code ${code})`))
    }

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId)
      globalThis.clearInterval(readinessInterval)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
    }

    serverProcess.on('error', onError)
    serverProcess.on('exit', onExit)
  })

  await setTimeout(1000)

  return serverProcess
}

async function stopServer(serverProcess: ChildProcess): Promise<void> {
  const killProcess = (signal: NodeJS.Signals) => {
    const pid = serverProcess.pid

    if (!pid) return

    if (process.platform === 'linux') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Fall through to direct process kill
      }
    }

    try {
      serverProcess.kill(signal)
    } catch {
      // Ignore if process already exited
    }
  }

  killProcess('SIGTERM')
  await new Promise<void>((resolve) => {
    serverProcess.on('exit', () => resolve())
    globalThis.setTimeout(() => {
      killProcess('SIGKILL')
      resolve()
    }, 5000)
  })
}

function createWsClient(format: JsonFormat | MsgpackFormat) {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format },
    WsTransportFactory,
    { url: SERVER_URL },
  )
}

function createBlobSource(content: string): {
  stream: ReadableStream<Uint8Array>
  size: number
} {
  const bytes = new TextEncoder().encode(content)
  return {
    size: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

async function readBlobToString(
  blobResponse:
    | AsyncIterable<ArrayBufferView>
    | ((options?: { signal?: AbortSignal }) => AsyncIterable<ArrayBufferView>),
): Promise<string> {
  const stream =
    typeof blobResponse === 'function' ? blobResponse({}) : blobResponse
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }

  return Buffer.concat(chunks).toString('utf-8')
}

describe('Playground E2E - WebSocket Streaming', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startServer('preview')
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServer(serverProcess)
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

  it('streams response from blob input over WebSocket transport with JSON format', async () => {
    const client = createWsClient(new JsonFormat())
    const content = 'hello from ws blob stream input'
    const source = createBlobSource(content)
    const blob = client.blob(source.stream, {
      type: 'text/plain',
      filename: 'ws-stream-blob-input.txt',
      size: source.size,
    })

    const result: string[] = []

    await client.connect()
    try {
      for await (const chunk of await client.stream.streamBlob({
        file: blob,
      })) {
        result.push(chunk.chunk)
      }
    } finally {
      await client.disconnect()
    }

    expect(result.join('')).toBe(content)
  })

  it('uploads and downloads blob over WebSocket transport with JSON format', async () => {
    const client = createWsClient(new JsonFormat())
    const content = 'hello from ws json blob'
    const source = createBlobSource(content)
    const blob = client.blob(source.stream, {
      type: 'text/plain',
      filename: 'ws-json-upload.txt',
      size: source.size,
    })

    await client.connect()
    try {
      const uploadResult = await client.call.uploadBlob({ file: blob })
      expect(uploadResult).toEqual({
        size: Buffer.byteLength(content),
        content,
        type: 'text/plain',
        filename: 'ws-json-upload.txt',
      })

      const downloadBlob = await client.call.downloadBlob({
        content,
        filename: 'ws-json-download.txt',
      })

      const downloadContent = await readBlobToString(downloadBlob)
      expect(downloadContent).toBe(content)
    } finally {
      await client.disconnect()
    }
  })

  it('uploads and downloads blob over WebSocket transport with Msgpack format', async () => {
    const client = createWsClient(new MsgpackFormat())
    const content = 'hello from ws msgpack blob'
    const source = createBlobSource(content)
    const blob = client.blob(source.stream, {
      type: 'text/plain',
      filename: 'ws-msgpack-upload.txt',
      size: source.size,
    })

    await client.connect()
    try {
      const uploadResult = await client.call.uploadBlob({ file: blob })
      expect(uploadResult).toEqual({
        size: Buffer.byteLength(content),
        content,
        type: 'text/plain',
        filename: 'ws-msgpack-upload.txt',
      })

      const downloadBlob = await client.call.downloadBlob({
        content,
        filename: 'ws-msgpack-download.txt',
      })

      const downloadContent = await readBlobToString(downloadBlob)
      expect(downloadContent).toBe(content)
    } finally {
      await client.disconnect()
    }
  })
})
