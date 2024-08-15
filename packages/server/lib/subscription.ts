import { isMainThread } from 'node:worker_threads'
import {
  Hook,
  type Subscription,
  WorkerType,
  createPlugin,
  providers,
  serialize,
} from '@nmtjs/application'
import { createBroadcastChannel } from './common.ts'

export const WORKER_THREADS_SM_MESSAGE = 'wt_sm_message'
export const WORKER_THREADS_SM_CHANNEL = 'wt_sm_channel'

export const WTSubManagerPlugin = createPlugin('WTPubManager', async (app) => {
  const { logger, type, container, hooks } = app
  const isApiWorker = type === WorkerType.Api
  const subscriptions = new Map<string, Set<Subscription<any>>>()

  let bc: ReturnType<typeof createBroadcastChannel> | undefined = undefined

  const subscribe = (subscription: Subscription) => {
    let subs = subscriptions.get(subscription.key)
    if (!subs) {
      subs = new Set()
      subscriptions.set(subscription.key, subs)
    }
    subs.add(subscription)
  }

  const unsubscribe = (subscription: Subscription) => {
    const subs = subscriptions.get(subscription.key)
    if (!subs) return
    subs.delete(subscription)
    if (!subs.size) subscriptions.delete(subscription.key)
  }

  const publish = (key: string, event: string, payload: any) => {
    if (!isMainThread) {
      bc!.postMessage({
        type: WORKER_THREADS_SM_MESSAGE,
        payload: {
          key,
          event,
          payload,
        },
      })
    }
    if (isApiWorker) emit(key, event, payload)
  }

  const emit = (key: string, event: string, payload: any) => {
    logger.debug(payload, `Emitting event [${key}] - ${event}`)
    const subs = subscriptions.get(key)
    if (subs?.size) {
      for (const sub of subs) {
        sub.send(event, payload)
      }
    }
  }

  const broadcastHandler = ({ key, event, payload }) => {
    logger.debug(payload, `Received event [${key}] - ${event}`)
    emit(key, event, payload)
  }

  if (!isMainThread) {
    bc = createBroadcastChannel(WORKER_THREADS_SM_CHANNEL)

    if (isApiWorker) {
      hooks.add(Hook.OnStartup, () => {
        bc!.on(WORKER_THREADS_SM_MESSAGE, broadcastHandler.bind(this))
      })
    }

    hooks.add(Hook.OnShutdown, () => bc!.close())
  }

  container.provide(providers.subManager, {
    publish,
    subscribe,
    unsubscribe,
    serialize,
  })
})
