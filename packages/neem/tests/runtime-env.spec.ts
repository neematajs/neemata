import { describe, expect, it } from 'vitest'

import type { Manifest } from '../src/internal/manifest/manifest.ts'
import { createRuntimeEnv } from '../src/internal/host/env.ts'

describe('Neem runtime env', () => {
  it('merges root defaults, runtime defaults, execution env, and test overrides', () => {
    const env = createRuntimeEnv({
      manifest: {
        config: {
          env: {
            ROOT_ONLY: 'root',
            LAYERED: 'root',
            EXECUTION_OVERRIDE: 'root',
            TEST_OVERRIDE: 'root',
          },
        },
        runtimes: {
          api: {
            env: {
              RUNTIME_ONLY: 'runtime',
              LAYERED: 'runtime',
              EXECUTION_OVERRIDE: 'runtime',
              TEST_OVERRIDE: 'runtime',
            },
          },
        },
      } as unknown as Manifest,
      runtimeName: 'api',
      executionEnv: {
        EXECUTION_ONLY: 'execution',
        EXECUTION_OVERRIDE: 'execution',
        TEST_OVERRIDE: 'execution',
      },
      overrideEnv: { TEST_ONLY: 'test', TEST_OVERRIDE: 'test' },
    })

    expect(env).toEqual({
      ROOT_ONLY: 'root',
      RUNTIME_ONLY: 'runtime',
      LAYERED: 'runtime',
      EXECUTION_ONLY: 'execution',
      EXECUTION_OVERRIDE: 'execution',
      TEST_ONLY: 'test',
      TEST_OVERRIDE: 'test',
    })
    expect(Object.isFrozen(env)).toBe(true)
  })
})
