import { existsSync, rmSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

import { defineRuntimeWorker } from '@nmtjs/neem'

export type AppWorkerData = {
  id: string
  createDelayMs?: number
  // Crashes once if this file exists, deleting it first.
  crashOnceFile?: string
  // `hang` never settles; `block` never yields the thread again.
  stop?: 'hang' | 'block' | 'throw'
}

// Every event reaches the test through this channel.
const channel = new BroadcastChannel('neem-unit')
const emit = (id: string, event: string) => channel.postMessage({ id, event })

export default defineRuntimeWorker<AppWorkerData, { app: true }>({
  definition: { app: true },
  async createRuntime({ data }) {
    emit(data.id, 'create')
    if (data.createDelayMs) await wait(data.createDelayMs)
    emit(data.id, 'created')
    return {
      start() {
        emit(data.id, 'start')
        // Crash only after the test has observed readiness of the entire generation.
        // A short timer could instead crash during sibling startup on a busy runner.
        channel.onmessage = (event) => {
          if (
            event.data?.crash === data.id &&
            data.crashOnceFile &&
            existsSync(data.crashOnceFile)
          ) {
            rmSync(data.crashOnceFile)
            throw new Error(`crash ${data.id}`)
          }
        }
        return []
      },
      async stop() {
        emit(data.id, 'stop')
        if (data.stop === 'hang') await new Promise(() => {})
        // oxlint-disable-next-line no-empty
        if (data.stop === 'block') for (;;) {}
        if (data.stop === 'throw') throw new Error(`stop failed ${data.id}`)
      },
    }
  },
})
