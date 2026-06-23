import { defineRuntimeWorker } from '@nmtjs/neem'

export default defineRuntimeWorker({
  definition: { fixture: 'bad-upstream' },
  createRuntime() {
    return {
      start() {
        return { upstreams: [{ type: 'http', url: 'not-a-valid-url' }] }
      },
      stop() {},
    }
  },
})
