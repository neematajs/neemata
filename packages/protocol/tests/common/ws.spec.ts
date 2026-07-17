import { describe, expect, it } from 'vitest'

import {
  encodeWsAuthSubprotocol,
  matchWsAuthSubprotocol,
  WS_AUTH_SUBPROTOCOL_PREFIX,
} from '../../src/common/ws.ts'

// RFC 6455 subprotocol names are RFC 2616 tokens: no separators, no spaces
const RFC6455_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

describe('encodeWsAuthSubprotocol', () => {
  it('produces a valid RFC 6455 subprotocol token for arbitrary values', () => {
    // values that are not tokens themselves: spaces, separators, unicode,
    // base64 padding/alphabet edge cases
    const tokens = [
      'Bearer abc.def.ghi',
      'a=b;c/d+e',
      'токен-😀',
      'x'.repeat(500),
    ]
    for (const token of tokens) {
      const subprotocol = encodeWsAuthSubprotocol(token)
      expect(subprotocol.startsWith(WS_AUTH_SUBPROTOCOL_PREFIX)).toBe(true)
      expect(subprotocol).toMatch(RFC6455_TOKEN)
    }
  })

  it('round-trips through matchWsAuthSubprotocol', () => {
    const subprotocol = encodeWsAuthSubprotocol('Bearer t')
    expect(matchWsAuthSubprotocol(subprotocol)).toEqual({
      auth: 'Bearer t',
      subprotocol,
    })
  })
})

describe('matchWsAuthSubprotocol', () => {
  it('returns null for a missing or empty header', () => {
    expect(matchWsAuthSubprotocol(null)).toBeNull()
    expect(matchWsAuthSubprotocol('')).toBeNull()
  })

  it('ignores foreign subprotocols', () => {
    expect(matchWsAuthSubprotocol('chat, graphql-ws')).toBeNull()
  })

  it('finds the auth entry among other offered subprotocols', () => {
    const subprotocol = encodeWsAuthSubprotocol('secret')
    const match = matchWsAuthSubprotocol(`chat, ${subprotocol}, superchat`)
    expect(match).toEqual({ auth: 'secret', subprotocol })
  })

  it('treats a prefixed entry with a malformed payload as foreign', () => {
    expect(
      matchWsAuthSubprotocol(`${WS_AUTH_SUBPROTOCOL_PREFIX}!!!not-base64!!!`),
    ).toBeNull()
  })

  it('round-trips a BOM-prefixed credential without stripping the BOM', () => {
    // a lossy decoder would collapse '﻿secret' and 'secret' into one
    const token = '﻿secret'
    const subprotocol = encodeWsAuthSubprotocol(token)
    expect(matchWsAuthSubprotocol(subprotocol)).toEqual({
      auth: token,
      subprotocol,
    })
  })

  it('rejects valid base64url that is not valid UTF-8', () => {
    // '_w' decodes to the lone byte 0xff — must not become U+FFFD
    expect(matchWsAuthSubprotocol(`${WS_AUTH_SUBPROTOCOL_PREFIX}_w`)).toBeNull()
  })
})
