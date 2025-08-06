import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  createTestingApplication,
  createTestMessage,
  TEST_CONFIG,
  TEST_HEADERS,
  TEST_ROUTES,
} from 'neemata-test-generic'
import type { Application } from 'nmtjs/application'
import { WsTransport } from 'nmtjs/ws-transport/bun'

describe('Bun', () => {
  let app: Application

  beforeAll(async () => {
    app = createTestingApplication().use(WsTransport, {
      listen: { unix: TEST_CONFIG.SOCKET_PATH },
    })
    await app.start()
  })

  it('should check status', async () => {
    const response = await fetch(`http://localhost${TEST_ROUTES.HEALTH}`, {
      unix: TEST_CONFIG.SOCKET_PATH,
    })
    expect(response.status).toBe(200)
    expect(response.text()).resolves.toBe('OK')
  })

  it('should handle http', async () => {
    const testMessage = createTestMessage('Bun')
    const response = await fetch(`http://localhost${TEST_ROUTES.API_TEST}`, {
      unix: TEST_CONFIG.SOCKET_PATH,
      method: 'POST',
      body: JSON.stringify(testMessage),
      headers: {
        'Content-Type': TEST_HEADERS.CONTENT_TYPE,
        Accept: TEST_HEADERS.ACCEPT,
      },
    })
    expect(response.status).toBe(200)
    expect(response.json()).resolves.toEqual(testMessage)
  })

  afterAll(async () => {
    await app?.stop()
    await Bun.file(TEST_CONFIG.SOCKET_PATH).delete()
  })
})
