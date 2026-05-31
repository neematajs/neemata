import { defineRuntimeHost } from '@nmtjs/neem'

import { record } from './_events.ts'

export default defineRuntimeHost((params) => {
  record({
    event: 'host-setup',
    mode: params.mode,
    name: params.name,
    options: params.options,
    artifact: params.artifact,
    hostArtifact: params.hostArtifact,
    logger: Boolean(params.logger),
  })

  return {
    plan() {
      record({ event: 'host-plan' })
      return {
        threads: [
          {
            name: 'worker',
            artifact: 'entry',
            count: 2,
            data: { label: 'planned' },
          },
        ],
      }
    },
    start(startParams) {
      record({
        event: 'host-start',
        threads: startParams.threads.map((thread) => thread.name),
        upstreams: startParams.upstreams,
      })
      for (const thread of startParams.threads) {
        thread.port.postMessage({ type: 'host-ready', thread: thread.name })
      }
    },
    stop(stopParams) {
      record({
        event: 'host-stop',
        threads: stopParams.threads.map((thread) => thread.name),
      })
    },
    fail(failParams) {
      record({
        event: 'host-fail',
        message: failParams.error.message,
        threads: failParams.threads.map((thread) => thread.name),
      })
    },
  }
})
