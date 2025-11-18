// // biome-ignore lint/correctness/noUnusedImports: TSC wants it
// // biome-ignore assist/source/organizeImports: TSC wants it
// import type {
//   kClassInjectable,
//   kClassInjectableCreate,
//   kClassInjectableDispose,
//   kInjectable,
// } from '@nmtjs/core/constants'

// import {
//   AppInjectables,
//   createCommand,
//   createApplication,
//   createJob,
//   createStep,
//   createApplicationPlugin,
// } from '@nmtjs/application'
// import {
//   createContractProcedure,
//   createContractRouter,
//   createFilter,
//   createGuard,
//   createMiddleware,
//   createProcedure,
//   createRouter,
// } from '@nmtjs/api'
// import {
//   CoreInjectables,
//   createClassInjectable,
//   createConsolePrettyDestination,
//   createExtendableClassInjectable,
//   createFactoryInjectable,
//   createHook,
//   createLazyInjectable,
//   createOptionalInjectable,
//   createValueInjectable,
// } from '@nmtjs/core'
// import { createTransport, ProtocolInjectables } from '@nmtjs/protocol/server'

// export const neemata = {
//   app: createApplication,
//   // server: createServer,
//   injectables: {
//     ...CoreInjectables,
//     ...ProtocolInjectables,
//     ...AppInjectables,
//   },
//   transport: createTransport,
//   plugin: createApplicationPlugin,
//   logging: {
//     console:
//       // TODO: TSC wants it
//       createConsolePrettyDestination as typeof createConsolePrettyDestination,
//   },
//   optional: createOptionalInjectable,
//   value: createValueInjectable,
//   lazy: createLazyInjectable,
//   factory: createFactoryInjectable,
//   class: createClassInjectable,
//   extendClass: createExtendableClassInjectable,
//   command: createCommand,
//   router: createRouter,
//   contractRouter: createContractRouter,
//   procedure: createProcedure,
//   contractProcedure: createContractProcedure,
//   middleware: createMiddleware,
//   guard: createGuard,
//   filter: createFilter,
//   job: createJob,
//   step: createStep,
//   hook: createHook,
// }

// export { ApiError } from '@nmtjs/api'
// export {
//   ApplicationType,
//   ApplicationWorkerType,
//   LifecycleHook,
//   defineApplication,
// } from '@nmtjs/application'
// export { c } from '@nmtjs/contract'
// export { Scope } from '@nmtjs/core'
// export { ErrorCode, ProtocolBlob, TransportType } from '@nmtjs/protocol'
// export { createStreamResponse } from '@nmtjs/protocol/server'
// export { t } from '@nmtjs/type'

// export { neemata as n }
// export default neemata
