import { createEffectRuntime } from '@nmtjs/effect'

export default createEffectRuntime({
  name: 'effect',
  worker: { entry: './app.worker.ts' },
})
