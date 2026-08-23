import { describe, expect, it } from 'vitest'

import { ProtocolError as ClientProtocolError } from '../src/client/protocol.ts'
import {
  ErrorCode,
  ProtocolError,
  toProtocolError,
} from '../src/common/index.ts'
import { ProtocolError as ServerProtocolError } from '../src/server/protocol.ts'

describe('ProtocolError', () => {
  it('is shared by the server, client, and common entry points', () => {
    expect(ServerProtocolError).toBe(ProtocolError)
    expect(ClientProtocolError).toBe(ProtocolError)
  })

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

describe('toProtocolError', () => {
  it('passes ProtocolError instances through unchanged', () => {
    const error = new ProtocolError('NotFound', 'missing', { id: 1 })
    expect(toProtocolError(error)).toBe(error)
  })

  it('sanitizes non-protocol errors without leaking their details', () => {
    for (const raw of [new Error('secret internals'), 'boom', { code: 'X' }]) {
      const normalized = toProtocolError(raw)
      expect(normalized).toBeInstanceOf(ProtocolError)
      expect(normalized.code).toBe(ErrorCode.InternalServerError)
      expect(normalized.message).toBe('Internal Server Error')
      expect(normalized.message).not.toContain('secret internals')
    }
  })

  it('serializes the sanitized code and message', () => {
    expect(
      JSON.parse(JSON.stringify(toProtocolError(new Error('boom')))),
    ).toEqual({
      name: ErrorCode.InternalServerError,
      message: 'Internal Server Error',
      code: ErrorCode.InternalServerError,
    })
  })
})
