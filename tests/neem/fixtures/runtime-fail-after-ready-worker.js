import { defineWorker } from '@nmtjs/neem'

export default defineWorker({
  kind: 'runtime-fail-after-ready-fixture',
  definition: {},
  createRuntime() {
    let timeout

    return {
      start() {
        timeout = setTimeout(() => {
          throw new Error('fixture plugin worker failure')
        }, 10)
      },
      stop() {
        clearTimeout(timeout)
      },
    }
  },
})
