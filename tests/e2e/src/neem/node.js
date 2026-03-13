import { createServer } from 'node:http'

import { defineApplication } from '@nmtjs/neem'

import { nodeDependencyRevision } from './node.dependency.js'

const adapter = {
  id: 'neem-e2e-http',
  async createRuntime({ applicationName, definition, mode, threadOptions }) {
    const options = { ...definition, ...(threadOptions ?? {}) }

    let server = null

    return {
      async start() {
        server = createServer((_, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              ok: true,
              app: applicationName,
              mode,
              revision: options.revision,
              dependencyRevision: options.dependencyRevision,
              host: options.host,
              port: options.port,
            }),
          )
        })

        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(options.port, options.host, resolve)
        })

        return [{ type: 'http', url: `http://${options.host}:${options.port}` }]
      },
      async stop() {
        if (!server) return

        const serverToClose = server
        server = null

        await new Promise((resolve, reject) => {
          serverToClose.close((error) => {
            if (error) {
              reject(error)
              return
            }

            resolve()
          })
        })
      },
      async reload(nextDefinition) {
        Object.assign(options, nextDefinition)
      },
    }
  },
}

export default defineApplication({
  adapter,
  commands: [],
  definition: {
    host: '127.0.0.1',
    port: 9999,
    revision: 'node-entry-v1',
    dependencyRevision: nodeDependencyRevision,
  },
})
