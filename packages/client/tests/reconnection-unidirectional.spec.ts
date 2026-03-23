import { describe, expect, it } from 'vitest'

import { StaticClient } from '../src/clients/static.ts'
import { reconnectPlugin } from '../src/plugins/reconnect.ts'
import {
  createBaseOptions,
  createMockUnidirectionalTransport,
} from './_helpers/transports.ts'

describe('reconnectPlugin (unidirectional)', () => {
  it('does not reconnect for unidirectional transport even with plugin installed', async () => {
    const { factory, transport } = createMockUnidirectionalTransport()
    const client = new StaticClient(
      { ...createBaseOptions(), plugins: [reconnectPlugin()] },
      factory,
      {},
    )

    await client.disconnect()

    expect(transport.type).toBe('Unidirectional')
  })
})
