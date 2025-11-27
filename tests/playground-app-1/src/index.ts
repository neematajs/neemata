import { setInterval } from 'node:timers/promises'

import { c } from 'nmtjs/contract'
import { createFactoryInjectable, Scope } from 'nmtjs/core'
import {
  createFilter,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
} from 'nmtjs/runtime'
import { t } from 'nmtjs/type'
import { WsTransport } from 'nmtjs/ws-transport/node'

const someAsyncThing = createFactoryInjectable({
  scope: Scope.Call,
  factory: async () => {
    const buffer = Buffer.alloc(1024)
    await new Promise((resolve) => setTimeout(resolve, 10))
    return buffer
  },
})

const simpleProcedure = createProcedure({
  input: t.array(
    t.object({
      id: t.string(),
      version: t.number(),
      name: t.string(),
      language: t.string(),
      bio: t.string().max(500),
    }),
  ),
  output: t.array(
    t.object({
      id: t.string(),
      version: t.number(),
      name: t.string(),
      language: t.string(),
    }),
  ),
  dependencies: { someAsyncThing },
  handler: (_, input) => input,
})

const strictProcedure = createProcedure({
  input: t.object({ test: t.date() }),
  output: t.object({ test: t.date() }),
  handler: (_, input) => input,
})

const blobProcedure = createProcedure({
  input: t.object({ blob: c.blob() }),
  output: t.object({}),
  handler: async (_, input) => {
    return {}
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
  transports: { ws: WsTransport },
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
