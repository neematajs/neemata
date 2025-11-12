// import type { CreateProcedureParams } from '@nmtjs/api'
// import type { Dependencies } from '@nmtjs/core'
// import type { ConnectionOptions } from '@nmtjs/protocol/server'
// import type { ArrayType } from '@nmtjs/type/array'
// import type { ObjectType } from '@nmtjs/type/object'
// import type { StringType } from '@nmtjs/type/string'
// import { createContractProcedure, createContractRouter } from '@nmtjs/api'
// import { noopFn } from '@nmtjs/common'
// import { c } from '@nmtjs/contract'
// import { createLogger } from '@nmtjs/core'
// import { Connection, createTransport } from '@nmtjs/protocol/server'
// import { t } from '@nmtjs/type'
// import { expect } from 'vitest'

// import type {
//   CommandArgsType,
//   CommandKwargsType,
//   CreateCommandOptions,
// } from '../src/commands.ts'
// import type { ApplicationConfig } from '../src/config.ts'
// import type { ApplicationPlugin } from '../src/plugins.ts'
// import { Application } from '../src/application.ts'
// import { createCommand } from '../src/commands.ts'
// import { defineApplication, resolveApplicationConfig } from '../src/config.ts'
// import { ApplicationType } from '../src/enums.ts'
// import { createApplicationPlugin } from '../src/plugins.ts'

// export const testTransport = (
//   onInit = () => {},
//   onStartup = async () => {},
//   onShutdown = async () => {},
//   onSend = async () => {},
// ) =>
//   createTransport('TestTransport', () => {
//     onInit()
//     return { start: onStartup, stop: onShutdown, send: onSend }
//   })

// export const testDefaultTimeout = 1000

// export const testPlugin = (
//   factory: ApplicationPlugin['factory'] = () => ({}),
// ) => createApplicationPlugin('TestPlugin', factory)

// export const testLogger = () =>
//   createLogger({ pinoOptions: { enabled: false } }, 'test')

// export const testApp = (options: Partial<ApplicationConfig> = {}) =>
//   new Application(
//     ApplicationType.Api,
//     resolveApplicationConfig(
//       defineApplication(() => ({
//         api: { timeout: testDefaultTimeout },
//         tasks: { timeout: testDefaultTimeout },
//         logging: { pinoOptions: { enabled: false } },
//         pubsub: {},
//         protocol: { formats: [] },
//         commands: { commands: [], options: { timeout: testDefaultTimeout } },
//         filters: [],
//         jobs: [],
//         plugins: [],
//         transports: [],
//         router: testRouter(),
//         ...options,
//       })),
//       ApplicationType.Api,
//     ),
//   )

// export const TestRouterContract = c.router({
//   routes: { testProcedure: c.procedure({ input: t.any(), output: t.any() }) },
//   events: { testEvent: c.event({ payload: t.string() }) },
// })

// export const testConnection = (options: ConnectionOptions = { data: {} }) => {
//   return new Connection(options)
// }

// export const testProcedure = (
//   params: CreateProcedureParams<
//     typeof TestRouterContract.routes.testProcedure,
//     any
//   >,
// ) => createContractProcedure(TestRouterContract.routes.testProcedure, params)

// export const testCommand = <
//   CommandDeps extends Dependencies,
//   CommandResult,
//   CommandArgs extends CommandArgsType = ArrayType<StringType>,
//   CommandKwargs extends CommandKwargsType = ObjectType<{}>,
// >(
//   options: CreateCommandOptions<
//     CommandResult,
//     CommandDeps,
//     CommandArgs,
//     CommandKwargs
//   > = {
//     // @ts-expect-error
//     handler: noopFn,
//   },
// ) => createCommand('test', { ...options })

// export const testRouter = (option?: {
//   routes: { testProcedure: ReturnType<typeof testProcedure> }
// }) =>
//   createContractRouter(TestRouterContract, {
//     routes: { testProcedure: testProcedure(noopFn), ...option?.routes },
//   })

// export const expectCopy = (source, targer) => {
//   expect(targer).not.toBe(source)
//   expect(targer).toEqual(source)
// }
