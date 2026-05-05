import { defineWorker } from '@nmtjs/neem/worker'

export default defineWorker({
  kind: 'runtime-channel-fixture',
  definition: {},
  createRuntime(ctx) {
    const onMessage = (message) => {
      ctx.port.postMessage({ type: 'plugin-reply', data: message })
    }

    return {
      start() {
        ctx.port.on('message', onMessage)
      },
      stop() {
        ctx.port.off('message', onMessage)
      },
    }
  },
})
