import { HttpTransport } from '@nmtjs/http-transport/node'
import { WsTransport } from '@nmtjs/ws-transport/node'
import { n } from 'nmtjs'

import app from './index.ts'

export default n.host(app, {
  transports: { ws: WsTransport, http: HttpTransport },
})
