import { createProtocolBlobReference } from '@nmtjs/protocol'
import { describe, expect, it } from 'vitest'

import { gatewayLoggerOptions } from '../src/gateway.ts'

describe('Gateway logger payload serializer', () => {
  it('renders blob placeholders instead of traversing them as objects', () => {
    const serialize = gatewayLoggerOptions.serializers!.payload
    const blob = createProtocolBlobReference(1, { size: 3, type: 'text/plain' })

    const result = serialize({
      file: blob,
      list: [blob],
      nested: { value: 42 },
    })

    const placeholder = `<ClientBlobStream metadata=${JSON.stringify(blob.metadata)}>`
    expect(result.file).toBe(placeholder)
    expect(result.list).toStrictEqual([placeholder])
    expect(result.nested).toStrictEqual({ value: 42 })
  })
})
