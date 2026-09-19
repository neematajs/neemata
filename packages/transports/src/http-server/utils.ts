import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

const textResponse = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  })

export const notFoundResponse = () => textResponse(404, 'Not Found')

export const internalServerErrorResponse = () =>
  textResponse(500, 'Internal Server Error')

export const payloadTooLargeResponse = () =>
  textResponse(413, 'Payload Too Large')

// The host's own liveness answer; deliberately without a content type, so
// probes see exactly the bytes this host has always returned.
export const okResponse = () => new Response('OK', { status: 200 })

/**
 * Shared error class: thrown inside runtime body translation and matched by
 * `instanceof` in transports to map onto 413 responses — both sides must see
 * the same class identity.
 */
export class PayloadTooLargeError extends Error {
  constructor(message = 'Payload Too Large') {
    super(message)
  }
}

/**
 * Handlers inherit the host body cap and may only tighten it: a handler cap
 * above the host bound could never take effect (the host rejects such bodies
 * first) — fail loudly at mount instead of letting the config lie.
 */
export function assertBodyLimit(
  handler: string,
  limit: number | undefined,
  hostLimit: number,
): void {
  if (limit !== undefined && limit > hostLimit) {
    throw new Error(
      `${handler} handler maxRequestBodySize (${limit}) ` +
        `exceeds the host limit (${hostLimit})`,
    )
  }
}

/**
 * Buffers a request body, rejecting mid-stream once the cap is exceeded so an
 * oversized upload is never fully held in memory. Holds the single cast
 * bridging the web stream to node's Readable.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of Readable.fromWeb(body as any)) {
    received += chunk.byteLength
    if (received > max) throw new PayloadTooLargeError()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
