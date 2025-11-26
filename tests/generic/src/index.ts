// import type { Application } from 'nmtjs/application'
// import type { TransportPlugin } from 'nmtjs/protocol/server'
// import { ApplicationType, defineApplication, n, t } from 'nmtjs'
// import { resolveApplicationConfig } from 'nmtjs/application'
// import { JsonFormat } from 'nmtjs/json-format'

// export const createTestingApplication = (
//   transport: TransportPlugin<any, any>,
//   transportOptions: unknown,
// ): Application => {
//   const router = n.router({
//     routes: {
//       test: n.procedure({
//         input: t.any(),
//         handler: (_, input) => {
//           return input
//         },
//       }),
//     },
//   })

//   const app = n.app(
//     ApplicationType.Api,
//     resolveApplicationConfig(
//       defineApplication(() => ({
//         api: { timeout: 10000 },
//         logging: {
//           pinoOptions: { enabled: true },
//           destinations: [n.logging.console('error')],
//         },
//         protocol: { formats: [new JsonFormat()] },
//         transports: [{ transport, options: transportOptions }],
//         router,
//       })),
//       ApplicationType.Api,
//       {},
//     ),
//   )

//   return app
// }

// export const createTestClient = () => {}

// export interface TestMessage {
//   message: string
// }

// export const createTestMessage = (runtime: string): TestMessage => ({
//   message: `Hello, ${runtime}!`,
// })

// export const TEST_ROUTES = {
//   HEALTH: '/healthy',
//   API_TEST: '/api/test',
// } as const

// export const TEST_HEADERS = {
//   CONTENT_TYPE: 'application/x-neemata-json',
//   ACCEPT: 'application/x-neemata-json',
// } as const

// export const TEST_CONFIG = {
//   SOCKET_PATH: './test.sock',
//   API_TIMEOUT: 10000,
// } as const
