import { StaticClient } from '@nmtjs/client/static'
import { JsonFormat } from '@nmtjs/json-format/client'
import { Protocol } from '@nmtjs/protocol/client'
import { WebSocketClientTransport } from '@nmtjs/ws-client'

const format = new JsonFormat()
const protocol = new Protocol(format)
const transport = new WebSocketClientTransport(protocol, {
  origin: 'http://localhost:4003',
})
const client = new StaticClient(transport, { timeout: 5000 })
await client.connect()
console.dir(await client.call.test())
// await client.disconnect()
