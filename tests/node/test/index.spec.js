import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'

import {
  createTestingApplication,
  createTestMessage,
  TEST_CONFIG,
  TEST_HEADERS,
  TEST_ROUTES,
} from 'neemata-test-generic'
import { WsTransport } from 'nmtjs/ws-transport/node'
import { Agent, request } from 'undici'

describe('Node.js', () => {
  /**
   * @type {import('nmtjs/application').Application}
   */
  let app
  const dispatcher = new Agent({
    connect: { socketPath: TEST_CONFIG.SOCKET_PATH },
  })

  before(async () => {
    app = createTestingApplication().use(WsTransport, {
      listen: { unix: TEST_CONFIG.SOCKET_PATH },
    })
    await app.start()
  })

  it('should check status', async () => {
    const response = await request(`http://localhost${TEST_ROUTES.HEALTH}`, {
      dispatcher,
    })
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(await response.body.text(), 'OK')
  })

  it('should handle http', async () => {
    const testMessage = createTestMessage('Node')
    const response = await request(`http://localhost${TEST_ROUTES.API_TEST}`, {
      dispatcher,
      method: 'POST',
      body: JSON.stringify(testMessage),
      headers: {
        'Content-Type': TEST_HEADERS.CONTENT_TYPE,
        Accept: TEST_HEADERS.ACCEPT,
      },
    })
    assert.deepStrictEqual(await response.body.json(), testMessage)
    assert.strictEqual(response.statusCode, 200)
  })

  after(async () => {
    await app?.stop()
    rmSync(TEST_CONFIG.SOCKET_PATH, { force: true })
  })
})
