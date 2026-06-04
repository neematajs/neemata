import { describe, expect, it } from 'vitest'

import {
  createRuntime,
  defineConfig,
  definePlugin,
  defineRuntime,
  isNeemRuntimeDeclaration,
} from '../../src/public/config.ts'
import {
  defineRuntimeHost,
  defineRuntimePlanner,
  isNeemRuntimeHostFactory,
  isNeemRuntimePlanner,
} from '../../src/public/runtime.ts'
import {
  defineRuntimeWorker,
  isNeemRuntimeWorker,
} from '../../src/public/worker.ts'

describe('Neem public runtime API', () => {
  it('keeps root runtimes as project entries', () => {
    const config = defineConfig({
      env: { NODE_ENV: 'production', REDIS_HOST: 'redis' },
      plugins: [
        definePlugin({
          name: 'fixture',
          entry: './plugin.ts',
          options: { enabled: true },
        }),
      ],
      runtimes: ['apps/*', 'packages/*/neem.runtime.ts', '!apps/legacy'],
    })

    expect(config.runtimes).toEqual([
      'apps/*',
      'packages/*/neem.runtime.ts',
      '!apps/legacy',
    ])
    expect(config.env).toEqual({ NODE_ENV: 'production', REDIS_HOST: 'redis' })
    expect(Object.isFrozen(config.env)).toBe(true)
    expect(config.plugins?.[0]?.name).toBe('fixture')
  })

  it('brands runtime declarations, planners, hosts, and workers', () => {
    const declaration = defineRuntime({
      name: 'api',
      planner: './neem.planner.ts',
      env: { REDIS_DB: '2' },
      worker: { entry: './worker.ts' },
    })
    const planner = defineRuntimePlanner(() => ({ workers: [{ id: 1 }] }))
    const host = defineRuntimeHost(() => ({}))
    const worker = defineRuntimeWorker({
      definition: {},
      createRuntime() {
        return { start() {}, stop() {} }
      },
    })

    expect(isNeemRuntimeDeclaration(declaration)).toBe(true)
    expect(declaration.env).toEqual({ REDIS_DB: '2' })
    expect(Object.isFrozen(declaration.env)).toBe(true)
    expect(isNeemRuntimePlanner(planner)).toBe(true)
    expect(isNeemRuntimeHostFactory(host)).toBe(true)
    expect(isNeemRuntimeWorker(worker)).toBe(true)
  })

  it('creates runtime factories with merged worker and host build options', () => {
    const commonWorkerPlugin = { name: 'common-worker' }
    const userWorkerPlugin = { name: 'user-worker' }
    const commonHostPlugin = { name: 'common-host' }
    const userHostPlugin = { name: 'user-host' }
    const runtime = createRuntime({
      env: { RUNTIME_ROOT: 'common', RUNTIME_LAYERED: 'common' },
      worker: {
        entry: './worker.ts',
        build: {
          rolldown: {
            output: { chunkFileNames: 'common-[hash].js' },
            plugins: [commonWorkerPlugin],
            transform: { define: { COMMON_FLAG: JSON.stringify(true) } },
          },
        },
      },
      host: {
        entry: './host.ts',
        build: { rolldown: { plugins: [commonHostPlugin] } },
      },
    })({
      name: 'api',
      planner: './planner.ts',
      env: { RUNTIME_LAYERED: 'user', RUNTIME_USER: 'user' },
      worker: {
        build: {
          rolldown: {
            output: { entryFileNames: 'worker.js' },
            plugins: [userWorkerPlugin],
            transform: { define: { USER_FLAG: JSON.stringify(true) } },
          },
        },
      },
      host: { build: { rolldown: { plugins: [userHostPlugin] } } },
    })

    expect(isNeemRuntimeDeclaration(runtime)).toBe(true)
    expect(runtime.env).toEqual({
      RUNTIME_ROOT: 'common',
      RUNTIME_LAYERED: 'user',
      RUNTIME_USER: 'user',
    })
    expect(Object.isFrozen(runtime.env)).toBe(true)
    expect(runtime.worker?.entry).toBe('./worker.ts')
    expect(runtime.worker?.build?.rolldown?.plugins).toEqual([
      commonWorkerPlugin,
      userWorkerPlugin,
    ])
    expect(runtime.worker?.build?.rolldown?.output).toEqual({
      chunkFileNames: 'common-[hash].js',
      entryFileNames: 'worker.js',
    })
    expect(runtime.worker?.build?.rolldown?.transform?.define).toEqual({
      COMMON_FLAG: 'true',
      USER_FLAG: 'true',
    })
    expect(runtime.host?.entry).toBe('./host.ts')
    expect(runtime.host?.build?.rolldown?.plugins).toEqual([
      commonHostPlugin,
      userHostPlugin,
    ])
  })
})
