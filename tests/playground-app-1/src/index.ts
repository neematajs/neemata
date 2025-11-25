import { setInterval } from 'node:timers/promises'

import { c } from '@nmtjs/contract'
import { ProtocolBlob } from '@nmtjs/protocol'
import { HttpTransport } from 'nmtjs/http-transport/node'
import {
  createFilter,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
} from 'nmtjs/runtime'
import { t } from 'nmtjs/type'
import { WsTransport } from 'nmtjs/ws-transport/node'

const simpleProcedure = createProcedure({
  input: t.any(),
  handler: (_, input) => input,
})

const strictProcedure = createProcedure({
  input: t.object({ test: t.date() }),
  output: t.object({ test: t.date() }),
  handler: (_, input) => input,
})

const blobProcedure = createProcedure({
  input: t.object({ blob: c.blob() }),
  output: t.object({ blob: c.blob() }),
  handler: async (_, input) => {
    return { blob: ProtocolBlob.from(input.blob) }
  },
})

const streamProcedure = createProcedure({
  input: t.object({ input: t.string() }),
  output: t.object({ input: t.string() }),
  stream: true,
  async *handler(_, input) {
    for await (const element of setInterval(1, input.input)) {
      yield { input: element }
    }
  },
})

export default defineApplication({
  router: createRootRouter(
    createRouter({
      routes: {
        simple: simpleProcedure,
        strict: strictProcedure,
        blob: blobProcedure,
        stream: streamProcedure,
      },
    }),
  ),
  transports: { http: HttpTransport, ws: WsTransport },
  filters: [
    createFilter({
      errorClass: Error,
      catch: (_, error) => {
        console.log('Caught error in filter:', error.message)
        return error
      },
    }),
  ],
})
