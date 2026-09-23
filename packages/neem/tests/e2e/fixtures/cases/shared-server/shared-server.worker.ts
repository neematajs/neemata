import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import type { NeemRuntimeUpstream, NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

// RFC 6455 handshake by hand: the fixture only has to prove that an upgrade
// reaches the shared socket, so a WebSocket library would add nothing.
const accept = (key: string) =>
  createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')

export default defineRuntimeWorker({
  definition: { fixture: 'shared-server' },
  createRuntime(ctx: NeemRuntimeWorkerContext) {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            procedure: request.url?.slice(1),
            payload: body ? JSON.parse(body) : null,
            runtime: ctx.name,
          }),
        )
      })
    })
    server.on('upgrade', (request, socket) => {
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept(request.headers['sec-websocket-key']!)}`,
          '',
          '',
        ].join('\r\n'),
      )
      socket.on('error', () => {})
      socket.on('data', () => socket.destroy())
    })

    return {
      async start(): Promise<NeemRuntimeUpstream[]> {
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        )
        const { port } = server.address() as AddressInfo
        // One socket serves both protocols, so the same bound URL is reported
        // under both proxyable types.
        const hosts: NeemRuntimeUpstream[] = [
          { type: 'http', url: `http://127.0.0.1:${port}` },
          { type: 'ws', url: `http://127.0.0.1:${port}` },
        ]
        record({ event: 'shared-server-hosts', name: ctx.name, hosts })
        return hosts
      },
      async stop() {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      },
    }
  },
})
