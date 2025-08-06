import { assertEquals } from '@std/assert'
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { n, t, WorkerType } from 'nmtjs'
import type { Application } from 'nmtjs/application'
import { JsonFormat } from 'nmtjs/json-format'
import { WsTransport } from 'nmtjs/ws-transport/deno'

describe('Deno', () => {
  let app: Application

  const client = Deno.createHttpClient({
    proxy: {
      // @ts-expect-error
      transport: 'unix',
      path: './test.sock',
    },
  })

  beforeAll(async () => {
    const namespace = n.namespace({
      name: 'test',
      procedures: {
        test: n.procedure({
          input: t.any(),
          handler: (_, input) => {
            return input
          },
        }),
      },
    })

    const router = n.router({ test: namespace })

    app = n
      .app({
        type: WorkerType.Api,
        api: {
          formats: [new JsonFormat()],
          timeout: 10000,
        },
        pubsub: {},
        tasks: { timeout: 10000 },
        logging: {
          pinoOptions: { enabled: true },
          destinations: [n.logging.console('error')],
        },
      })
      .use(WsTransport, { listen: { unix: './test.sock' } })
      .withRouter(router)

    await app.start()
  })

  it('should check status', async () => {
    const response = await fetch('http://localhost/healthy', {
      //@ts-expect-error
      client,
    })
    assertEquals(response.status, 200)
    assertEquals(await response.text(), 'OK')
  })

  it('should handle http', async () => {
    const response = await fetch('http://localhost/api/test/test', {
      //@ts-expect-error
      client,
      method: 'POST',
      body: JSON.stringify({ message: 'Hello, Deno!' }),
      headers: {
        'Content-Type': 'application/x-neemata-json',
        Accept: 'application/x-neemata-json',
      },
    })
    assertEquals(response.status, 200)
    assertEquals(await response.json(), { message: 'Hello, Deno!' })
  })

  afterAll(async () => {
    await app?.stop()
    Deno.removeSync('./test.sock')
  })
})
