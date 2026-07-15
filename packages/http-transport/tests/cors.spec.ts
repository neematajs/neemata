import { describe, expect, it } from 'vitest'

import {
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

const ORIGIN = 'https://app.example.com'
const ALLOW_ORIGIN = 'Access-Control-Allow-Origin'
const ALLOW_CREDENTIALS = 'Access-Control-Allow-Credentials'

async function preflight(cors: any) {
  const { params } = createTestParams()
  const server = await createTestServer({ cors }, params)
  return await server.httpHandler(
    createTestRequest({ origin: ORIGIN }, 'OPTIONS'),
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

  it('omits credentials for custom params with origin: true', async () => {
    const response = await preflight({ origin: true })

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })

  it('enables credentials for custom params with explicit origins', async () => {
    const response = await preflight({ origin: [ORIGIN] })

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('enables credentials when a custom function vets the origin', async () => {
    const response = await preflight((origin: string) => origin === ORIGIN)

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBe('true')
  })

  it('omits credentials when a custom function reflects any origin', async () => {
    const response = await preflight(() => ({ origin: true }))

    expect(response.headers.get(ALLOW_ORIGIN)).toBe(ORIGIN)
    expect(response.headers.get(ALLOW_CREDENTIALS)).toBeNull()
  })
})
