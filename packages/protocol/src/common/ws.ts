/**
 * WebSocket auth subprotocol encoding, shared by the WS client and server
 * transports. Browsers' WebSocket constructor cannot set arbitrary headers,
 * so the auth token rides `Sec-WebSocket-Protocol` instead of the URL, where
 * it would leak into proxy/access logs, browser history and Referer.
 */

/**
 * Distinguishes the auth entry from real application subprotocols.
 */
export const WS_AUTH_SUBPROTOCOL_PREFIX = 'nmt.auth.'

export type WsAuthSubprotocol = {
  auth: string
  /**
   * The exact offered entry — the server must echo it in the handshake
   * response, or browsers fail the connection.
   */
  subprotocol: string
}

export const encodeWsAuthSubprotocol = (auth: string): string => {
  const bytes = new TextEncoder().encode(auth)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  // base64url without padding: '+', '/' and '=' are not valid subprotocol
  // token characters per RFC 6455, arbitrary token values are
  return (
    WS_AUTH_SUBPROTOCOL_PREFIX +
    btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  )
}

/**
 * Finds the auth entry among the offered subprotocols — the raw
 * `Sec-WebSocket-Protocol` header value, a comma-separated list.
 */
export const matchWsAuthSubprotocol = (
  header: string | null,
): WsAuthSubprotocol | null => {
  if (!header) return null
  for (const entry of header.split(',')) {
    const subprotocol = entry.trim()
    if (!subprotocol.startsWith(WS_AUTH_SUBPROTOCOL_PREFIX)) continue
    const payload = subprotocol
      .slice(WS_AUTH_SUBPROTOCOL_PREFIX.length)
      .replaceAll('-', '+')
      .replaceAll('_', '/')
    try {
      const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
      return { auth: new TextDecoder().decode(bytes), subprotocol }
    } catch {
      // malformed payload — treat as a foreign subprotocol
    }
  }
  return null
}
