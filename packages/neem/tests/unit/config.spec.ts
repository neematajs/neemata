import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  NeemPluginInput,
  NeemRuntimeBuildConfig,
  NeemRuntimeDeclaration,
  NeemRuntimePlanner,
  NeemRuntimePlannerContext,
  NeemRuntimeProxyConfig,
} from '../../src/shared/types.ts'
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
      build: {
        define: { __NEEM_ROOT__: JSON.stringify('root') },
        minify: 'dce-only',
        sourcemap: 'hidden',
        sourcemapSources: 'exclude',
      },
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
    expect(config.build).toEqual({
      define: { __NEEM_ROOT__: '"root"' },
      minify: 'dce-only',
      sourcemap: 'hidden',
      sourcemapSources: 'exclude',
    })
    expect(Object.isFrozen(config.env)).toBe(true)
    expect(config.plugins?.[0]?.name).toBe('fixture')
  })

  it('brands runtime declarations, planners, hosts, and workers', () => {
    const runtimeInput = {
      name: 'api',
      planner: './neem.planner.ts',
      env: { REDIS_DB: '2' },
      proxy: { routing: { type: 'default' }, sni: 'api.localhost' },
      worker: { entry: './worker.ts' },
    } satisfies NeemRuntimeDeclaration
    const declaration = defineRuntime(runtimeInput)
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
    expect(declaration.proxy).toEqual({
      routing: { type: 'default' },
      sni: 'api.localhost',
    })
    expect(Object.isFrozen(declaration.env)).toBe(true)
    expect(isNeemRuntimePlanner(planner)).toBe(true)
    expect(isNeemRuntimeHostFactory(host)).toBe(true)
    expect(isNeemRuntimeWorker(worker)).toBe(true)
  })

  it('types default proxy routing as a routing mode', () => {
    const defaultRoute = {
      routing: { type: 'default' },
    } satisfies NeemRuntimeProxyConfig
    const missingRoutingType = {
      // @ts-expect-error explicit routing config must declare a type.
      routing: { name: 'api' },
    } satisfies NeemRuntimeProxyConfig
    const deprecatedDefaultFlag = {
      routing: {
        type: 'path',
        // @ts-expect-error default route is now expressed as type: 'default'.
        default: true,
      },
    } satisfies NeemRuntimeProxyConfig

    expect(defaultRoute.routing.type).toBe('default')
    expect(missingRoutingType.routing.name).toBe('api')
    expect(deprecatedDefaultFlag.routing.default).toBe(true)
  })

  it('types runtime planner helper by options and worker data', () => {
    type PlannerOptions = { factory: () => string }
    type WorkerData = { poolName: string }

    const planner = defineRuntimePlanner<PlannerOptions, WorkerData>(
      (ctx: NeemRuntimePlannerContext) => {
        expect(ctx.mode).toBeTypeOf('string')
        return {
          workers: [{ poolName: 'default' }],
          options: { factory: () => ctx.name },
        }
      },
    )

    const inferredPlanner = defineRuntimePlanner<PlannerOptions, WorkerData>(
      () => ({
        workers: [{ poolName: 'default' }],
        options: { factory: () => 'value' },
      }),
    )

    expectTypeOf(planner).toEqualTypeOf<
      NeemRuntimePlanner<PlannerOptions, WorkerData>
    >()
    expectTypeOf(inferredPlanner).toEqualTypeOf<
      NeemRuntimePlanner<PlannerOptions, WorkerData>
    >()
  })

  it('limits public rolldown build options to compile-time customization', () => {
    const pluginBuild = {
      rolldown: {
        external: ['react'],
        resolve: {
          alias: { '@runtime': './runtime.ts' },
          conditionNames: ['node', 'import'],
          extensionAlias: { '.js': ['.ts', '.js'] },
          exportsFields: [['exports']],
          extensions: ['.ts', '.js'],
          mainFields: ['module', 'main'],
          mainFiles: ['index'],
          modules: ['node_modules'],
          symlinks: true,
        },
        moduleTypes: { '.txt': 'text' },
        transform: {
          define: { __NEEM_TEST__: JSON.stringify(true) },
          inject: { Buffer: ['node:buffer', 'Buffer'] },
          dropLabels: ['DEV_ONLY'],
          jsx: 'react-jsx',
        },
        checks: { circularDependency: true },
        tsconfig: false,
      },
    } satisfies NonNullable<NeemPluginInput['build']>

    const runtimeBuild = pluginBuild satisfies NeemRuntimeBuildConfig
    expect(runtimeBuild.rolldown.resolve?.alias).toEqual({
      '@runtime': './runtime.ts',
    })

    const disallowedInput = {
      // @ts-expect-error Neem owns artifact entries.
      input: './entry.ts',
    } satisfies NonNullable<NeemRuntimeBuildConfig['rolldown']>
    const disallowedOutput = {
      // @ts-expect-error Neem owns output layout and chunk names.
      output: { entryFileNames: 'entry.js' },
    } satisfies NonNullable<NeemRuntimeBuildConfig['rolldown']>
    const disallowedCwd = {
      // @ts-expect-error Neem owns build cwd normalization.
      cwd: '/workspace/app',
    } satisfies NonNullable<NeemRuntimeBuildConfig['rolldown']>
    const disallowedWatch = {
      // @ts-expect-error Neem owns watch lifecycle.
      watch: { buildDelay: 100 },
    } satisfies NonNullable<NeemRuntimeBuildConfig['rolldown']>
    const disallowedExperimental = {
      // @ts-expect-error Neem owns experimental bundler knobs.
      experimental: { chunkOptimization: false },
    } satisfies NonNullable<NeemRuntimeBuildConfig['rolldown']>

    expect([
      disallowedInput,
      disallowedOutput,
      disallowedCwd,
      disallowedWatch,
      disallowedExperimental,
    ]).toHaveLength(5)
  })

  it('creates runtime factories with merged worker and host build options', () => {
    const commonWorkerPlugin = { name: 'common-worker' }
    const userWorkerPlugin = { name: 'user-worker' }
    const commonHostPlugin = { name: 'common-host' }
    const userHostPlugin = { name: 'user-host' }
    const commonChunkGroup = { name: 'common', test: /common/ }
    const userChunkGroup = { name: 'user', test: /user/ }
    const runtime = createRuntime({
      env: { RUNTIME_ROOT: 'common', RUNTIME_LAYERED: 'common' },
      worker: {
        entry: './worker.ts',
        build: {
          chunks: { groups: [commonChunkGroup] },
          rolldown: {
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
          chunks: { groups: [userChunkGroup] },
          rolldown: {
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
    expect(runtime.worker?.build?.chunks).toEqual({ groups: [userChunkGroup] })
    expect(runtime.worker?.build?.rolldown).not.toHaveProperty('output')
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

  it('creates runtime factories with merged proxy options', () => {
    const runtime = createRuntime({
      proxy: { routing: { type: 'path', name: 'api' } },
    })({
      name: 'api',
      proxy: { sni: 'api.localhost' },
      worker: { entry: './worker.ts' },
    })

    expect(runtime.proxy).toEqual({
      routing: { type: 'path', name: 'api' },
      sni: 'api.localhost',
    })
  })
})
