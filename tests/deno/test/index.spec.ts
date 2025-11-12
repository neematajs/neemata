import type { Application } from 'nmtjs/application'
import { assertEquals } from '@std/assert'
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import {
  createTestingApplication,
  createTestMessage,
  TEST_CONFIG,
  TEST_HEADERS,
  TEST_ROUTES,
} from 'neemata-test-generic'
import { WsTransport } from 'nmtjs/ws-transport/deno'

describe('Deno', () => {
  let app: Application

  const client = Deno.createHttpClient({
    proxy: {
      // @ts-expect-error
      transport: 'unix',
      path: TEST_CONFIG.SOCKET_PATH,
    },
  })

  beforeAll(async () => {
    app = createTestingApplication(WsTransport, {
      listen: { unix: TEST_CONFIG.SOCKET_PATH },
    })
    await app.start()
  })

  it('should check status', async () => {
    const response = await fetch(`http://localhost${TEST_ROUTES.HEALTH}`, {
      //@ts-expect-error
      client,
    })
    assertEquals(response.status, 200)
    assertEquals(await response.text(), 'OK')
  })

  it('should handle http', async () => {
    const testMessage = createTestMessage('Deno')
    const response = await fetch(`http://localhost${TEST_ROUTES.API_TEST}`, {
      //@ts-expect-error
      client,
      method: 'POST',
      body: JSON.stringify(testMessage),
      headers: {
        'Content-Type': TEST_HEADERS.CONTENT_TYPE,
        Accept: TEST_HEADERS.ACCEPT,
      },
    })
    assertEquals(response.status, 200)
    assertEquals(await response.json(), testMessage)
  })

  afterAll(async () => {
    await app?.stop()
    Deno.removeSync(TEST_CONFIG.SOCKET_PATH)
  })
})
