import {
  createRootRouter,
  defineApplication,
  defineApplicationHost,
} from '@nmtjs/application'
import { defineNeemataWorker } from '@nmtjs/application/neem/worker'
import { ExecutionEnvironmentLifecycleHook } from '@nmtjs/core'

import { record } from './events.ts'
import { marker } from './marker.ts'
import { testTransport } from './transport.ts'

const application = defineApplication({
  router: createRootRouter([]),
  lifecycleHooks: {
    [ExecutionEnvironmentLifecycleHook.Start]: () => {
      record({ event: 'application:start', marker })
    },
    [ExecutionEnvironmentLifecycleHook.Stop]: () => {
      record({ event: 'application:stop', marker })
    },
  },
})

export default defineNeemataWorker(
  defineApplicationHost(application, {
    transports: { test: testTransport },
  }),
)
