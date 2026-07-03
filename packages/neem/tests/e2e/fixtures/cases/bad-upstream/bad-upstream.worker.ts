import { defineRuntimeWorker } from '@nmtjs/neem'

export default defineRuntimeWorker({
  definition: { fixture: 'bad-upstream' },
  createRuntime() {
    return {
      start() {
        return [{ type: 'http' as const, url: 'not-a-valid-url' }]
      },
      stop() {},
    }
  },
})
