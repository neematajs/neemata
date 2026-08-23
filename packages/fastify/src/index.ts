import type { MaybePromise } from '@nmtjs/common'
import type { Container, Logger } from '@nmtjs/core'
import type {
  NeemMode,
  NeemRuntimePlanner,
  NeemRuntimePlannerContext,
} from '@nmtjs/neem'
import { ExecutionEnvironment } from '@nmtjs/core'
import { defineRuntimePlanner, defineRuntimeWorker } from '@nmtjs/neem'

export type FastifyLikeInstance = {
  listen(options: { host: string; port: number }): Promise<string>
  close(): Promise<void>
}

export type FastifyRuntimeContext = {
  container: Container
  logger: Logger
  mode: NeemMode
  name: string
}

export type FastifyAppFactory = (
  ctx: FastifyRuntimeContext,
) => MaybePromise<FastifyLikeInstance>

export type FastifyPlannerInput = {
  instances?: number
}

export type FastifyRuntimePlanner = NeemRuntimePlanner<undefined, undefined>

export function defineFastifyPlanner(
  factory: (
    ctx: NeemRuntimePlannerContext,
  ) => MaybePromise<FastifyPlannerInput>,
): FastifyRuntimePlanner {
  return defineRuntimePlanner<undefined, undefined>(async (ctx) => {
    const { instances = 1 } = await factory(ctx)
    if (!Number.isSafeInteger(instances) || instances < 1) {
      throw new Error(
        `Fastify instances must be a positive integer, received [${instances}]`,
      )
    }

    return {
      workers: Array.from({ length: instances }, () => undefined),
    }
  })
}

export function defineFastifyWorker(app: FastifyAppFactory) {
  return defineRuntimeWorker<undefined, FastifyAppFactory>({
    definition: app,
    createRuntime(ctx) {
      const execution = new ExecutionEnvironment({ logger: ctx.logger })
      let server: FastifyLikeInstance | undefined

      return {
        async start() {
          server = await ctx.definition({
            container: execution.container,
            logger: execution.logger,
            mode: ctx.mode,
            name: ctx.name,
          })
          const url = await server.listen({ host: '127.0.0.1', port: 0 })

          // Fastify handles HTTP requests and WebSocket upgrades on one
          // listener, while the Neem proxy routes them through separate pools.
          return [
            { type: 'http' as const, url },
            { type: 'ws' as const, url },
          ]
        },
        async stop() {
          const current = server
          server = undefined
          try {
            await current?.close()
          } finally {
            await execution.dispose()
          }
        },
      }
    },
  })
}
