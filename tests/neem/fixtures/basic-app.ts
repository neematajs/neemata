import type { ApplicationTransport } from '@nmtjs/application'
import { createRootRouter, defineApplication } from '@nmtjs/application'
import { defineNeemataApp } from '@nmtjs/application/neem'

export type BasicAppThreadOptions = {
  http: { listen: { hostname: string; port: number } }
}

const httpTransport = {
  proxyable: 'http' as NonNullable<
    ApplicationTransport<any, BasicAppThreadOptions['http']>['proxyable']
  >,
  factory(options: BasicAppThreadOptions['http']) {
    return {
      start() {
        const { hostname = '127.0.0.1', port } = options.listen
        return `http://${hostname}:${port}`
      },
      stop() {},
    }
  },
} satisfies ApplicationTransport<any, BasicAppThreadOptions['http']>

const application = defineApplication({
  router: createRootRouter([]),
  transports: { http: httpTransport },
})

export default defineNeemataApp(application)
