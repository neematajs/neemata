import {
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
} from 'nmtjs/runtime'
import { WsTransport } from 'nmtjs/ws-transport/node'

const router = createRouter({
  routes: { test: createProcedure({ handler: () => 'test' }) },
})

export default defineApplication({
  router: createRootRouter(router),
  transports: { ws: WsTransport },
})
