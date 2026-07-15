import { describe, expect, it } from 'vitest'

import type { HttpTransportCorsOptions } from '../src/types.ts'
import {
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

const ORIGIN = 'https://app.example.com'
const ALLOW_ORIGIN = 'Access-Control-Allow-Origin'
const ALLOW_CREDENTIALS = 'Access-Control-Allow-Credentials'

async function preflight(
  cors: HttpTransportCorsOptions,
  origin: string | null = ORIGIN,
) {
  const { params } = createTestParams()
  const server = await createTestServer({ cors }, params)
  return await server.httpHandler(
    createTestRequest(origin === null ? {} : { origin }, 'OPTIONS'),
    null,
    new AbortController().signal,
  )
}

describe('CORS credentials defaults', () => {
  it('omits Allow-Credentials while still allowing origin for cors: true', async () => {
    const response = await preflight(true)

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })

  it('enables credentials for explicit origin allowlist', async () => {
    const response = await preflight([ORIGIN])

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('skips CORS headers entirely for origins not in the allowlist', async () => {
    const response = await preflight(['https://other.example.com'])

    expect(response.headers.get(ALLOW_ORIGIN)).toBeNull()
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })

  it('omits credentials by default for custom params with origin: true', async () => {
    const response = await preflight({ origin: true })

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })

  it('allows explicit credentials with reflected origins', async () => {
    const response = await preflight({
      origin: true,
      allowCredentials: 'true',
    })

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('enables credentials for custom params with explicit origins', async () => {
    const response = await preflight({ origin: [ORIGIN] })

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('enables credentials when a custom function vets the origin', async () => {
    const response = await preflight((origin) => origin === ORIGIN)

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('omits credentials when a custom function reflects any origin', async () => {
    const response = await preflight(() => ({ origin: true }))

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })

  it('enables credentials for function params listing the requesting origin', async () => {
    const response = await preflight(() => ({ origin: [ORIGIN] }))

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('skips CORS headers when function params do not list the requesting origin', async () => {
    const response = await preflight(() => ({
      origin: ['https://trusted.example.com'],
    }))

    expect(response.headers.get(ALLOW_ORIGIN)).toBeNull()
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })
})

describe('CORS Vary header', () => {
  it('adds Vary: Origin for allowed origins', async () => {
    const response = await preflight(true)

    expect(response.headers.get('Vary')).toBe('Origin')
  })

  it('adds Vary: Origin for disallowed origins', async () => {
    const response = await preflight(['https://other.example.com'])

    expect(response.headers.get('Vary')).toBe('Origin')
    expect(response.headers.get(ALLOW_ORIGIN)).toBeNull()
  })

  it('adds Vary: Origin when the request has no Origin header', async () => {
    const response = await preflight(true, null)

    expect(response.headers.get('Vary')).toBe('Origin')
  })

  it('omits Vary: Origin when cors is not configured', async () => {
    const { params } = createTestParams()
    const server = await createTestServer({}, params)
    const response = await server.httpHandler(
      createTestRequest({ origin: ORIGIN }, 'OPTIONS'),
      null,
      new AbortController().signal,
    )

    expect(response.headers.get('Vary')).toBeNull()
  })

  it('merges Vary from custom rpc responses instead of overwriting', async () => {
    const { params } = createTestParams()
    params.onRpc = async () =>
      new Response(null, { headers: { Vary: 'Accept-Encoding' } })
    const server = await createTestServer({ cors: true }, params)
    const response = await server.httpHandler(
      createTestRequest({ origin: ORIGIN }),
      null,
      new AbortController().signal,
    )

    expect(response.headers.get('Vary')).toBe('Origin, Accept-Encoding')
  })
})

describe('CORS config type surface', () => {
  it('accepts serializable explicit credentials with reflected origins', () => {
    const allowAll = Math.random() >= 0
    const allowedOrigins = [ORIGIN]

    // Composing origin as `true | string[]` without credentials must be valid
    const composed: HttpTransportCorsOptions = {
      origin: allowAll ? true : allowedOrigins,
    }
    const credentialed: HttpTransportCorsOptions = {
      origin: allowedOrigins,
      allowCredentials: 'true',
    }
    const reflectedCredentials: HttpTransportCorsOptions = {
      origin: true,
      allowCredentials: 'true',
    }

    expect(composed).toBeDefined()
    expect(credentialed).toBeDefined()
    expect(reflectedCredentials).toBeDefined()
  })
})
