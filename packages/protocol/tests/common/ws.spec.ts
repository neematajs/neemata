import { describe, expect, it } from 'vitest'

import {
  encodeWsAuthSubprotocol,
  matchWsAuthSubprotocol,
  WS_AUTH_SUBPROTOCOL_PREFIX,
} from '../../src/common/ws.ts'

// RFC 6455 subprotocol names are RFC 2616 tokens: no separators or spaces.
const RFC6455_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

describe('encodeWsAuthSubprotocol', () => {
  it('produces a valid RFC 6455 token for arbitrary values', () => {
    for (const auth of [
      'Bearer abc.def.ghi',
      'a=b;c/d+e',
      'токен-😀',
      'x'.repeat(500),
    ]) {
      const subprotocol = encodeWsAuthSubprotocol(auth)
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
  it('ignores missing and foreign subprotocols', () => {
    expect(matchWsAuthSubprotocol(null)).toBeNull()
    expect(matchWsAuthSubprotocol('')).toBeNull()
    expect(matchWsAuthSubprotocol('chat, graphql-ws')).toBeNull()
  })

  it('finds the auth entry among other offers', () => {
    const subprotocol = encodeWsAuthSubprotocol('secret')
    expect(matchWsAuthSubprotocol(`chat, ${subprotocol}, superchat`)).toEqual({
      auth: 'secret',
      subprotocol,
    })
  })

  it('treats malformed auth entries as foreign', () => {
    expect(
      matchWsAuthSubprotocol(`${WS_AUTH_SUBPROTOCOL_PREFIX}!!!not-base64!!!`),
    ).toBeNull()
  })

  it('preserves a leading BOM in the credential', () => {
    const auth = '﻿secret'
    const subprotocol = encodeWsAuthSubprotocol(auth)
    expect(matchWsAuthSubprotocol(subprotocol)).toEqual({ auth, subprotocol })
  })

  it('rejects base64url that is not valid UTF-8', () => {
    // _w is the lone byte 0xff; replacement decoding must not turn it into U+FFFD.
    expect(matchWsAuthSubprotocol(`${WS_AUTH_SUBPROTOCOL_PREFIX}_w`)).toBeNull()
  })
})
