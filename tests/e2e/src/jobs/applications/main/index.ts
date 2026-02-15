import { HttpTransport } from '@nmtjs/http-transport/node'
import { WsTransport } from '@nmtjs/ws-transport/node'
import { n } from 'nmtjs'

import { router } from './router.ts'

export default n.app({
  transports: { ws: WsTransport, http: HttpTransport },
  router,
})
