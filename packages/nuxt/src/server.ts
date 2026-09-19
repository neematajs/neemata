import type { Server } from 'node:http'

/**
 * Binds a worker-owned listener to an ephemeral loopback port and reports it.
 * The error listener is the only one on the server until it is bound, so it
 * can be dropped wholesale once the address is known.
 */
export async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeAllListeners('error')
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Nuxt server listener did not report a tcp address')
  }
  return address.port
}

/**
 * The Neem proxy holds keep-alive upstream connections; a graceful close
 * would wait on those idle sockets indefinitely.
 */
export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}
