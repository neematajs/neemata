export const NotFoundHttpResponse = () =>
  new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  })

export const InternalServerErrorHttpResponse = () =>
  new Response('Internal Server Error', {
    status: 500,
    headers: { 'Content-Type': 'text/plain' },
  })

export const OkResponse = () => new Response('OK', { status: 200 })

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
