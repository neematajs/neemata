import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { n, t, WorkerType } from 'nmtjs'
import { JsonFormat } from 'nmtjs/json-format'
import { WsTransport } from 'nmtjs/ws-transport/node'
import { Agent, request } from 'undici'

describe('Node.js', () => {
  /**
   * @type {import('nmtjs/application').Application}
   */
  let app
  const dispatcher = new Agent({ connect: { socketPath: './test.sock' } })

  before(async () => {
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
    const response = await request('http://localhost/healthy', {
      dispatcher,
    })
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(await response.body.text(), 'OK')
  })

  it('should handle http', async () => {
    const response = await request('http://localhost/api/test/test', {
      dispatcher,
      method: 'POST',
      body: JSON.stringify({ message: 'Hello, Node!' }),
      headers: {
        'Content-Type': 'application/x-neemata-json',
        Accept: 'application/x-neemata-json',
      },
    })
    assert.deepStrictEqual(await response.body.json(), {
      message: 'Hello, Node!',
    })
    assert.strictEqual(response.statusCode, 200)
  })

  after(async () => {
    await app?.stop()
    rmSync('./test.sock', { force: true })
  })
})
