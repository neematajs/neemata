import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

import type { TransportWorker } from '@nmtjs/gateway'
import type { NeemRuntimePlanner, NeemRuntimePlannerContext } from '@nmtjs/neem'
import { createLogger, createValueInjectable } from '@nmtjs/core'
import { createTransport, StreamTimeout } from '@nmtjs/gateway'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ApplicationTransport } from '../src/config.ts'
import type { ApplicationHostDefinition } from '../src/host.ts'
import type { NeemataRuntimeThreadOptions } from '../src/neem/types.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  defineApplicationHost,
} from '../src/index.ts'
import * as planner from '../src/neem/planner.ts'
import * as runtime from '../src/neem/runtime.ts'
import * as worker from '../src/neem/worker.ts'

const testDir = dirname(fileURLToPath(import.meta.url))

type HttpOptions = { listen: { hostname: string; port: number } }
type TestHost = ApplicationHostDefinition<
  any,
  { http: ApplicationTransport<any, HttpOptions> }
>

describe('Neem application entrypoints', () => {
  it('keeps runtime, planner, and worker APIs in separate subpath files', () => {
    expect(existsSync(join(testDir, '../src/neem.ts'))).toBe(false)

    expect(runtime.createNeemataRuntime).toEqual(expect.any(Function))
    expect(planner.defineNeemataPlanner).toEqual(expect.any(Function))
    expect(worker.defineNeemataWorker).toEqual(expect.any(Function))
    expect(worker.NeemataApplicationRuntime).toEqual(expect.any(Function))
  })

  it('creates Neemata runtimes with only package-owned worker build defaults', () => {
    const defineRuntime = runtime.createNeemataRuntime()
    const declaration = defineRuntime({
      name: 'api',
      planner: './api.planner.ts',
      worker: { entry: './api.worker.ts' },
    })

    expect(declaration).toMatchObject({
      name: 'api',
      planner: './api.planner.ts',
      worker: { entry: './api.worker.ts' },
    })
    expect(declaration.worker?.build?.rolldown?.plugins).toEqual([
      expect.objectContaining({ name: 'neemata:uws-native-addon' }),
    ])
  })

  it('types Neemata planner helpers as core Neem runtime planners', () => {
    const runtimePlanner = planner.defineNeemataPlanner<TestHost>(
      async (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<NeemRuntimePlannerContext>()
        return {
          instances: 2,
          transports: { http: { listen: { hostname: '127.0.0.1', port: 0 } } },
        }
      },
    )

    expectTypeOf(runtimePlanner).toEqualTypeOf<
      NeemRuntimePlanner<undefined, NeemataRuntimeThreadOptions<TestHost>>
    >()
  })

  it('propagates host gateway and identity options through Neem worker runtime', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const identity = createValueInjectable('worker-identity')
    const transportWorker: TransportWorker = {
      start: async () => 'test://worker',
      stop: async () => {},
    }
    const transport = createTransport({
      proxyable: undefined,
      factory: async (_options: HttpOptions) => transportWorker,
    })
    const app = defineApplication({
      router: createRootRouter([
        createRouter({
          routes: {
            ping: createProcedure({
              input: t.object({ ok: t.boolean() }),
              output: t.object({ ok: t.boolean() }),
              handler: async (_ctx, input) => input,
            }),
          },
        }),
      ] as const),
    })
    const host = defineApplicationHost(app, {
      transports: { http: transport },
      gateway: {
        heartbeat: { interval: 4321, timeout: 8765 },
        streamTimeouts: { [StreamTimeout.Pull]: 1111 },
      },
      identity,
    })
    const runtimeWorker = worker.defineNeemataWorker(host)
    const channel = new MessageChannel()
    const created = (await runtimeWorker.createRuntime({
      mode: 'development',
      name: 'api',
      data: { http: { listen: { hostname: '127.0.0.1', port: 0 } } },
      logger,
      definition: runtimeWorker.definition,
      port: channel.port1,
    })) as worker.NeemataApplicationRuntime<typeof host>

    try {
      await created.start()

      expect(created.host.gateway.options.heartbeat).toEqual({
        interval: 4321,
        timeout: 8765,
      })
      expect(
        created.host.gateway.options.streamTimeouts[StreamTimeout.Pull],
      ).toBe(1111)
      expect(created.host.gateway.options.identity).toBe(identity)
    } finally {
      await created.stop()
      channel.port1.close()
      channel.port2.close()
    }
  })
})
