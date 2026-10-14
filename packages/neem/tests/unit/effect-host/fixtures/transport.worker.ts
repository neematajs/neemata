import { setTimeout as wait } from 'node:timers/promises'
import { parentPort, workerData } from 'node:worker_threads'

import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'

import { TestRpcs } from './transport-protocol.ts'

if (workerData.mode === 'exit-before-ready') process.exit(7)
if (workerData.mode === 'fatal-before-ready') {
  parentPort!.postMessage([
    2,
    { name: 'Error', message: 'fatal before exit', origin: 'runtime' },
  ])
  process.exit(9)
}
if (workerData.delay) await wait(workerData.delay)

const handlers = TestRpcs.toLayer({
  ping: () => Effect.succeed('pong'),
  port: ({ port }) =>
    Effect.sync(() => {
      port.postMessage('transferred')
      port.close()
    }),
  crash: () =>
    Effect.sync(() => {
      process.exit(8)
    }),
  stop: () =>
    Effect.sync(() => {
      process.exit(0)
    }),
})

Effect.runFork(
  Layer.launch(
    RpcServer.layer(TestRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolWorkerRunner),
      Layer.provide(NodeWorkerRunner.layer),
    ),
  ),
)
