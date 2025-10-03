import type { Application } from 'nmtjs/application'
import { n, t, WorkerType } from 'nmtjs'
import { JsonFormat } from 'nmtjs/json-format'

export const createTestingApplication = (): Application => {
  const router = n.router({
    name: 'test',
    routes: {
      test: n.procedure({
        input: t.any(),
        handler: (_, input) => {
          return input
        },
      }),
    },
  })

  const app = n
    .app({
      type: WorkerType.Api,
      api: { formats: [new JsonFormat()], timeout: 10000 },
      pubsub: {},
      tasks: { timeout: 10000 },
      logging: {
        pinoOptions: { enabled: true },
        destinations: [n.logging.console('error')],
      },
    })
    .withRouter(router)

  return app
}

export const createTestClient = () => {}

export interface TestMessage {
  message: string
}

export const createTestMessage = (runtime: string): TestMessage => ({
  message: `Hello, ${runtime}!`,
})

export const TEST_ROUTES = {
  HEALTH: '/healthy',
  API_TEST: '/api/test/test',
} as const

export const TEST_HEADERS = {
  CONTENT_TYPE: 'application/x-neemata-json',
  ACCEPT: 'application/x-neemata-json',
} as const

export const TEST_CONFIG = {
  SOCKET_PATH: './test.sock',
  API_TIMEOUT: 10000,
} as const
