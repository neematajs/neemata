import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { NeemRuntimePlanner, NeemRuntimePlannerContext } from '@nmtjs/neem'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ApplicationTransport } from '../src/config.ts'
import type { ApplicationHostDefinition } from '../src/host.ts'
import type { NeemataRuntimeThreadOptions } from '../src/neem/types.ts'
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
})
