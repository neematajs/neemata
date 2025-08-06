import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { n, t, WorkerType } from 'nmtjs'
import type { Application } from 'nmtjs/application'
import { JsonFormat } from 'nmtjs/json-format'
import { WsTransport } from 'nmtjs/ws-transport/bun'

describe('Bun', () => {
  let app: Application

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
      unix: './test.sock',
    })
    expect(response.status).toBe(200)
    expect(response.text()).resolves.toBe('OK')
  })

  it('should handle http', async () => {
    const response = await fetch('http://localhost/api/test/test', {
      unix: './test.sock',
      method: 'POST',
      body: JSON.stringify({ message: 'Hello, Bun!' }),
      headers: {
        'Content-Type': 'application/x-neemata-json',
        Accept: 'application/x-neemata-json',
      },
    })
    expect(response.status).toBe(200)
    expect(response.json()).resolves.toEqual({ message: 'Hello, Bun!' })
  })

  afterAll(async () => {
    await app?.stop()
    await Bun.file('./test.sock').delete()
  })
})
