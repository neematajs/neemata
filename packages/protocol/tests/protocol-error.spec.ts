import { describe, expect, it } from 'vitest'

import { ProtocolError as ClientProtocolError } from '../src/client/protocol.ts'
import { ProtocolError as ServerProtocolError } from '../src/server/protocol.ts'

describe.each([
  ['server', ServerProtocolError],
  ['client', ClientProtocolError],
])('ProtocolError (%s)', (_, ProtocolError) => {
  it('keeps the code out of message and toJSON', () => {
    const error = new ProtocolError('BadRequest', 'boom', { field: 'a' })
    expect(error.message).toBe('boom')
    expect(error.toString()).toBe('BadRequest boom')
    expect(error.toJSON()).toEqual({
      name: 'BadRequest',
      message: 'boom',
      data: { field: 'a' },
      code: 'BadRequest',
    })
  })

  it('does not accumulate code prefixes across serialization round trips', () => {
    let error = new ProtocolError('Forbidden', 'nope')
    for (let i = 0; i < 3; i++) {
      const wire = JSON.parse(JSON.stringify(error))
      error = new ProtocolError(wire.code, wire.message, wire.data)
    }
    expect(error.message).toBe('nope')
    expect(error.toJSON().message).toBe('nope')
    expect(error.toString()).toBe('Forbidden nope')
  })
})
