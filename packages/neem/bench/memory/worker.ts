import { createServer } from 'node:http'

import { defineRuntimeWorker } from '@nmtjs/neem'

export default defineRuntimeWorker({
  definition: {},
  createRuntime() {
    const server = createServer((_request, response) => {
      response.end('neem-memory-benchmark')
    })
    return {
      async start() {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Expected a TCP address')
        }
        return [
          { type: 'http' as const, url: `http://127.0.0.1:${address.port}` },
        ]
      },
      async stop() {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      },
    }
  },
})
