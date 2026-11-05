import { defineRuntimeHost } from '@nmtjs/neem'

// The test picks the host's stop behaviour through the runtime environment.
export default defineRuntimeHost(() => ({
  stop: () =>
    process.env.NEEM_EFFECT_TEST_HOST_STOP === 'hang'
      ? new Promise<void>(() => {})
      : undefined,
}))
