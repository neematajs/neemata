import assert from 'node:assert'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TServiceContract } from '@neematajs/contract'
import { Procedure } from './api.ts'
import { Hook } from './constants.ts'
import { Hooks } from './hooks.ts'
import type {
  AnyGuard,
  AnyMiddleware,
  AnyProcedure,
  HooksInterface,
} from './types.ts'

export class Service<Contract extends TServiceContract = TServiceContract> {
  constructor(public readonly contract: Contract) {}

  procedures = new Map<string, AnyProcedure>()
  guards = new Set<AnyGuard>()
  middlewares = new Set<AnyMiddleware>()
  hooks = new Hooks()

  implement<
    K extends Extract<keyof Contract['procedures'], string>,
    I extends Procedure<Contract['procedures'][K], any, any>,
  >(name: K, implementaion: I) {
    this.procedures.set(name, implementaion)
    return this
  }

  withHook<T extends Hook>(hook: T, handler: HooksInterface[T]) {
    this.hooks.add(hook, handler)
    return this
  }

  withAutoload(directory: string | URL) {
    const dirpath =
      directory instanceof URL ? fileURLToPath(directory) : directory
    this.hooks.add(
      Hook.BeforeInitialize,
      autoLoader(path.resolve(dirpath), this),
    )
    return this
  }

  withGuard(guard: AnyGuard) {
    this.guards.add(guard)
    return this
  }

  withMiddleware(middleware: AnyMiddleware) {
    this.middlewares.add(middleware)
    return this
  }
}

const autoLoader = (directory: string, service: Service) => async () => {
  const procedureNames = Object.keys(service.contract.procedures)
  const extensions = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']
  const ignore = ['.d.ts', '.d.mts', '.d.cts']
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (ignore.some((ext) => entry.name.endsWith(ext))) continue
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
    const procedureName = path.parse(
      path.join(entry.parentPath, entry.name),
    ).name
    if (!procedureNames.includes(procedureName)) continue
    const filepath = path.join(entry.parentPath, entry.name)
    let implementation: any = null
    // TODO: this might be not very reliable
    if (typeof module === 'undefined') {
      implementation = await import(filepath).then((m) => m.default)
    } else {
      implementation = require(filepath)
    }
    assert(implementation instanceof Procedure, 'Invalid procedure')
    service.implement(procedureName, implementation as any)
  }
}

// const service = new Service(DashboardServiceContract)
//   // .withGuard((ctx) => true)
//   // .withMiddleware((ctx) => {})
//   .withAutoload('./procedures')
//   .implement(
//     'getDashboard',
//     new Procedure(DashboardServiceContract, 'getDashboard')
//       .withDependencies({ connection: Procedure.connection })
//       .withHandler((ctx, data) => {
//         return data
//       }),
//   )
//   .implement(
//     'chat',
//     new Procedure(DashboardServiceContract, 'chat')
//       .withDependencies({
//         eventManager: Application.eventManager,
//         connection: Procedure.connection,
//         options: Procedure.options,
//       })
//       .withHandler(async ({ eventManager, connection, options }) => {
//         // connection.transport === TransportType.WS && connection.
//         // options.serviceContract.procedures.chat.output
//         const { subscription } = await eventManager.subscribe(
//           options.serviceContract,
//           options.procedureName,
//           {},
//           connection,
//         )

//         subscription.send('join', { a: '123' })
//         subscription.once('event', () => {})
//         // const subscribe = new Subscription<(typeof this.contract)['output']>()
//         return subscription
//       }),
//   )

// export class TestConnection extends BaseTransportConnection {
//   transport = TransportType.WS as const
//   data = { test: 'data' } as const

//   protected sendEvent(eventName: string, payload: any): boolean | null {
//     return null
//   }

//   myCustomConnectionMethod() {
//     // ...
//   }
// }

// export class TestTranport extends BaseTransport<
//   TransportType.WS,
//   TestConnection
// > {
//   name = 'Test transport'
//   start() {}
//   stop() {}
// }

// export class Test2Connection extends BaseTransportConnection {
//   transport = TransportType.HTTP as const
//   data = { test: 'data' }

//   protected sendEvent(eventName: string, payload: any): boolean | null {
//     return null
//   }
// }

// export class Test2Tranport extends BaseTransport<
//   TransportType.HTTP,
//   Test2Connection
// > {
//   name = 'Test2 transport'
//   start() {}
//   stop() {}
// }

// const WsProcedure =
//   Procedure.$withTransports<[typeof TestTranport, typeof Test2Tranport]>()

// WsProcedure(DashboardServiceContract, 'getDashboard')
//   .withDependencies({
//     connection: Procedure.connection,
//     signal: Procedure.signal,
//   })
//   .withHandler((ctx, data) => {
//     ctx.connection.notify(DashboardServiceContract, 'closePlayer', { a: '123' })
//     ctx.connection.transport === TransportType.WS && ctx.connection.data.test
//     return data
//   })
