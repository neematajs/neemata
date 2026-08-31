import type { Container, Provision } from '@nmtjs/core'
import type {
  GatewayConnection,
  GatewayOptions,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type {
  NeemRuntime,
  NeemRuntimeHmrAdapter,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'
import {
  anyAbortSignal,
  createFuture,
  OperationQueue,
  TeardownStack,
  withTimeout,
} from '@nmtjs/common'
import { createValueInjectable, provision, Scope } from '@nmtjs/core'
import { GATEWAY_TEARDOWN_STEP_TIMEOUT, Gateway } from '@nmtjs/gateway'
import * as gatewayInjectables from '@nmtjs/gateway'

import type { ApplicationResolvedProcedure } from '../api/api.ts'
import type { ApplicationTransport } from '../config.ts'
import type {
  AnyApplicationHostDefinition,
  ApplicationHostDefinition,
  ApplicationHostTransportConfig,
} from '../host.ts'
import type {
  NeemataRuntimeContext,
  NeemataRuntimeThreadOptions,
  NeemataRuntimeTransportOptions,
} from '../neem/types.ts'
import { ApplicationHost } from '../host.ts'

type ConnectionInput = {
  data: unknown
  injections: readonly Provision[]
}

type ReloadGatewayOptions = Required<
  Pick<
    GatewayOptions<ApplicationResolvedProcedure>,
    'api' | 'container' | 'hooks' | 'identity'
  >
>

type GatewayActivity = {
  connectionId?: string
  controller?: AbortController
  finished: Promise<void>
  finish: () => void
}

type ReloadableConnection = Omit<
  GatewayConnection,
  'container' | 'identity'
> & {
  container: GatewayConnection['container']
  identity: GatewayConnection['identity']
}

export class ReloadableGateway extends Gateway<ApplicationResolvedProcedure> {
  private readonly activities = new Set<GatewayActivity>()
  private readonly connectionInputs = new Map<string, ConnectionInput>()
  private readonly reloads = new OperationQueue()

  override async stop(): Promise<void> {
    if (this.reloads.busy) await this.reloads.waitIdle()
    await super.stop()
  }

  reload(options: ReloadGatewayOptions): Promise<void> {
    return this.reloads.run(() => this.performReload(options))
  }

  protected override onConnect(
    transport: string,
  ): TransportWorkerParams<ApplicationResolvedProcedure>['onConnect'] {
    const connect = super.onConnect(transport)
    return (options, ...injections) =>
      this.runActivity(async () => {
        const connection = await connect(options, ...injections)
        this.connectionInputs.set(connection.id, {
          data: options.data,
          injections: [...injections],
        })
        return connection
      })
  }

  protected override onDisconnect(
    transport: string,
  ): TransportWorkerParams<ApplicationResolvedProcedure>['onDisconnect'] {
    const disconnect = super.onDisconnect(transport)
    return (connectionId) =>
      this.runActivity(async (activity) => {
        this.abortActivities(connectionId)
        await this.waitForActivities(connectionId, activity)
        try {
          await disconnect(connectionId)
        } finally {
          this.connectionInputs.delete(connectionId)
        }
      })
  }

  protected override resolve(
    transport: string,
  ): TransportWorkerParams<ApplicationResolvedProcedure>['resolve'] {
    const resolve = super.resolve(transport)
    return (connection, procedure) =>
      this.runActivity(() => resolve(connection, procedure), connection.id)
  }

  protected override onRpc(
    _transport: string,
  ): TransportWorkerParams<ApplicationResolvedProcedure>['onRpc'] {
    return async (connection, rpc, signal, ...injections) => {
      const controller = new AbortController()
      const activity = await this.beginActivityWhenIdle(
        connection.id,
        controller,
      )
      const callSignal = anyAbortSignal(
        signal,
        controller.signal,
        connection.abortController.signal,
      )
      const container = connection.container.fork(Scope.Call)
      let disposal: Promise<void> | undefined
      const dispose = () => {
        disposal ??= container.dispose().finally(() => {
          this.endActivity(activity)
        })
        return disposal
      }

      try {
        container.provide([
          ...injections,
          provision(gatewayInjectables.rpcClientAbortSignal, callSignal),
        ])
        const result = await this.options.api.call({
          connection,
          container,
          payload: rpc.payload,
          procedure: rpc.procedure,
          signal: callSignal,
        })

        if (typeof result === 'function') return result(dispose)
        await dispose()
        return result
      } catch (error) {
        await dispose()
        throw error
      }
    }
  }

  private async performReload(options: ReloadGatewayOptions): Promise<void> {
    this.abortActivities()
    await this.waitForActivities()

    const replacements: Array<{
      connection: GatewayConnection
      container: Container
      identity: string
    }> = []
    try {
      for (const connection of this.connections.getAll()) {
        const input = this.connectionInputs.get(connection.id)
        if (!input) {
          throw new Error(
            `Cannot reload gateway connection [${connection.id}] without its connection inputs`,
          )
        }

        const container = options.container.fork(Scope.Connection)
        try {
          container.provide([
            provision(gatewayInjectables.connectionData, input.data),
            provision(gatewayInjectables.connectionId, connection.id),
            ...input.injections,
          ])
          const identity = await container.resolve(options.identity)
          container.provide([
            provision(gatewayInjectables.connection, connection),
            provision(
              gatewayInjectables.connectionAbortSignal,
              connection.abortController.signal,
            ),
          ])
          replacements.push({ connection, container, identity })
        } catch (error) {
          await container.dispose()
          throw error
        }
      }
    } catch (error) {
      await Promise.allSettled(
        replacements.map(({ container }) => container.dispose()),
      )
      throw error
    }

    this.options.api = options.api
    this.options.container = options.container
    this.options.hooks = options.hooks
    this.options.identity = options.identity
    const previousScopes = replacements.map(
      ({ connection: immutableConnection, container, identity }) => {
        const connection = immutableConnection as ReloadableConnection
        const previous = connection.container
        connection.container = container
        connection.identity = identity
        return { connectionId: connection.id, container: previous }
      },
    )

    // Once the new generation is visible, cleanup failures are resource leaks,
    // not a reason to report that the committed application was rolled back.
    const cleanup = await Promise.allSettled(
      previousScopes.map(({ container }) => container.dispose()),
    )
    for (let index = 0; index < cleanup.length; index++) {
      const result = cleanup[index]
      if (result.status === 'rejected') {
        this.logger.error(
          {
            error: result.reason,
            connectionId: previousScopes[index].connectionId,
          },
          'Error disposing previous connection scope after gateway reload',
        )
      }
    }
  }

  private async runActivity<T>(
    run: (activity: GatewayActivity) => Promise<T>,
    connectionId?: string,
  ): Promise<T> {
    const activity = await this.beginActivityWhenIdle(connectionId)
    try {
      return await run(activity)
    } finally {
      this.endActivity(activity)
    }
  }

  private async beginActivityWhenIdle(
    connectionId?: string,
    controller?: AbortController,
  ): Promise<GatewayActivity> {
    // Register in the same turn as the final idle check so a reload cannot
    // start in the microtask gap between observing idle and becoming visible.
    while (this.reloads.busy) await this.reloads.waitIdle()
    return this.beginActivity(connectionId, controller)
  }

  private beginActivity(
    connectionId?: string,
    controller?: AbortController,
  ): GatewayActivity {
    const finished = createFuture<void>()
    const activity = {
      connectionId,
      controller,
      finished: finished.promise,
      finish: () => finished.resolve(),
    }
    this.activities.add(activity)
    return activity
  }

  private endActivity(activity: GatewayActivity): void {
    if (!this.activities.delete(activity)) return
    activity.finish()
  }

  private abortActivities(connectionId?: string): void {
    for (const activity of this.activities) {
      if (
        connectionId === undefined ||
        activity.connectionId === connectionId
      ) {
        activity.controller?.abort()
      }
    }
  }

  private async waitForActivities(
    connectionId?: string,
    exclude?: GatewayActivity,
  ): Promise<void> {
    const pending = [...this.activities]
      .filter(
        (activity) =>
          activity !== exclude &&
          (connectionId === undefined ||
            activity.connectionId === connectionId),
      )
      .map((activity) => activity.finished)
    if (pending.length === 0) return

    await withTimeout(
      Promise.allSettled(pending),
      GATEWAY_TEARDOWN_STEP_TIMEOUT,
      new Error('Gateway activities did not drain before application reload'),
    )
  }
}

class ReloadableApplicationHost<
  Transports extends Record<string, ApplicationTransport>,
> extends ApplicationHost<Transports> {
  declare gateway: ReloadableGateway

  async reload(
    hostDefinition: ApplicationHostDefinition<any, Transports>,
  ): Promise<void> {
    const previous = this.activeApplication
    if (!previous || this.lifecycle.state !== 'running') {
      throw new Error('The application host must be started before reload')
    }

    const next = {
      application: await this.createApplication(hostDefinition.application),
      services: new TeardownStack(),
    }
    try {
      await this.startApplication(next)
      await this.gateway.reload({
        api: next.application.api,
        container: next.application.container,
        hooks: next.application.lifecycleHooks,
        identity: this.options.identity ?? this.gateway.options.identity,
      })
    } catch (error) {
      const cleanupErrors = await this.disposeApplication(next)
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Failed to reload the application and clean up the replacement',
        )
      }
      throw error
    }

    this.appConfig = hostDefinition.application
    this.setActiveApplication(next)
    // The replacement is already serving calls; cleanup failures must not
    // make the HMR protocol report that this committed generation was rejected.
    const cleanupErrors = await this.disposeApplication(previous)
    for (const error of cleanupErrors) {
      this.options.logger.error(
        { error },
        'Error disposing previous application after reload',
      )
    }
  }

  protected override createGateway(
    options: GatewayOptions<ApplicationResolvedProcedure>,
  ): ReloadableGateway {
    return new ReloadableGateway(options)
  }
}

class NeemataApplicationHmrRuntime<
  THost extends AnyApplicationHostDefinition,
> implements NeemRuntime {
  readonly host: ReloadableApplicationHost<THost['transports']>

  constructor(ctx: NeemataRuntimeContext<THost>) {
    this.host = new ReloadableApplicationHost(ctx.definition.application, {
      name: ctx.name,
      logger: ctx.logger,
      transports: createHostTransportConfig(
        ctx.definition.transports,
        ctx.data,
      ),
      identity: ctx.definition.identity,
    })
  }

  start() {
    return this.host.start()
  }

  stop() {
    return this.host.stop()
  }
}

export function createNeemataHmrAdapter<
  THost extends AnyApplicationHostDefinition,
>(): NeemRuntimeHmrAdapter<NeemataRuntimeThreadOptions<THost>, THost> {
  return {
    createRuntime(_worker, ctx) {
      return new NeemataApplicationHmrRuntime(
        ctx as NeemRuntimeWorkerContext<
          NeemataRuntimeThreadOptions<THost>,
          THost
        >,
      )
    },
    async apply(runtime, current, next) {
      if (!(runtime instanceof NeemataApplicationHmrRuntime)) {
        return {
          accepted: false,
          reason: 'Application runtime was not created by its HMR adapter',
        }
      }
      if (
        next.definition.identity !== current.definition.identity ||
        !haveSameTransports(
          next.definition.transports,
          current.definition.transports,
        )
      ) {
        return {
          accepted: false,
          reason:
            'Application identity or transport changes require a full runtime reload',
        }
      }

      await runtime.host.reload(next.definition)
      return { accepted: true }
    },
  }
}

function createHostTransportConfig<
  Transports extends Record<string, ApplicationTransport>,
>(
  transports: Transports,
  options: NeemataRuntimeTransportOptions<Transports>,
): ApplicationHostTransportConfig<Transports> {
  const config = {} as ApplicationHostTransportConfig<Transports>
  for (const key in transports) {
    config[key] = {
      transport: transports[key],
      options: createValueInjectable(options[key]),
    }
  }
  return config
}

function haveSameTransports(
  next: Record<string, ApplicationTransport>,
  current: Record<string, ApplicationTransport>,
): boolean {
  const keys = Object.keys(next)
  return (
    keys.length === Object.keys(current).length &&
    keys.every((key) => next[key] === current[key])
  )
}
