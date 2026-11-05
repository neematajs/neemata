import type { Server } from 'node:http'

// How soon a keep-alive connection is closed once its last response is done.
const IDLE_REAP_INTERVAL_MS = 100

/**
 * Closes an HTTP server without failing the requests it is still serving.
 * New connections are refused at once and in-flight responses finish.
 * Keep-alive connections, such as the Neem proxy's pooled upstream
 * connections, close as soon as they are idle: `server.close()` alone closes
 * only the ones idle when it is called, so it would otherwise wait on a
 * connection that finished its response later. Once `signal` aborts (see
 * `NeemRuntimeStopOptions`), every remaining connection is closed.
 *
 * Upgraded connections (WebSockets) are not tracked by the HTTP server; their
 * owner must close them.
 */
export function closeHttpServer(
  server: Server,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options
  return new Promise<void>((resolve, reject) => {
    const reap = setInterval(
      () => server.closeIdleConnections(),
      IDLE_REAP_INTERVAL_MS,
    )
    const force = () => server.closeAllConnections()
    signal?.addEventListener('abort', force, { once: true })
    server.close((error?: NodeJS.ErrnoException) => {
      clearInterval(reap)
      signal?.removeEventListener('abort', force)
      // A server that never listened or already closed has nothing to drain.
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
    if (signal?.aborted) force()
  })
}
