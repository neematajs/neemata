import { HttpTransport } from 'nmtjs/http-transport/node'
import {
  createRootRouter,
  createRouter,
  defineApplication,
} from 'nmtjs/runtime'

export default defineApplication({
  router: createRootRouter(createRouter({ routes: {} })),
  transports: { http: HttpTransport },
})
