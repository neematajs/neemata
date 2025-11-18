// import type { WsTransportOptions } from 'nmtjs/ws-transport'
// import { ApplicationWorkerType, defineApplication, n, t } from 'nmtjs'
// import { JsonFormat } from 'nmtjs/json-format'
// import { ProtocolHook } from 'nmtjs/protocol/server'
// import { JobManager } from 'nmtjs/server'
// import { WsTransport } from 'nmtjs/ws-transport/node'

// import { testCommand } from './command.ts'
// import router from './router.ts'

// const testJob1 = n
//   .job(`test1`, { type: ApplicationWorkerType.Io })
//   .add(
//     n.step({
//       input: t.object({ testInput: t.string() }),
//       output: t.object({ message: t.string() }),
//       async handler() {
//         return { message: 'Hello from compute Io step!' }
//       },
//     }),
//   )
//   .add(
//     n.step({
//       input: t.object({ message: t.string() }),
//       output: t.object({ length: t.number() }),
//       async handler(_, { message }) {
//         return { length: message.length }
//       },
//     }),
//   )

// const testJob2 = n
//   .job(`test2`, { type: ApplicationWorkerType.Compute, attemts: 2 })
//   .add(
//     n.step({
//       input: t.object({}),
//       output: t.object({ message: t.string() }),
//       async handler() {
//         return { message: 'Hello from compute job step!' }
//       },
//     }),
//   )
//   .add(
//     n.step({
//       input: t.object({ message: t.string() }),
//       output: t.object({ length: t.number() }),
//       async handler(_, { message }) {
//         return { length: message.length }
//       },
//     }),
//   )

// const hook = n.hook({
//   name: ProtocolHook.Connect,
//   dependencies: { jobManager: JobManager },
//   handler: async ({ jobManager }, c) => {
//     console.dir(c)
//   },
// })

// export default defineApplication(() => ({
//   router,
//   logging: { pinoOptions: { level: 'trace' } },
//   protocol: { formats: [new JsonFormat()] },
//   pubsub: {},
//   transports: [
//     {
//       transport: WsTransport,
//       options: { listen: { port: 4003 } } as WsTransportOptions,
//     },
//   ],
//   jobs: [testJob1, testJob2],
//   hooks: [hook],
//   commands: { commands: [testCommand], options: { timeout: 30_000 } },
// }))

export {}
