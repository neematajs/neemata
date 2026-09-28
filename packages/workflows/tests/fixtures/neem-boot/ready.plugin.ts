import { definePluginHooks } from '@nmtjs/neem'

// A production start.js emits no readiness probe; this hook observes boot in
// every mode, once all runtimes have started.
export default definePluginHooks(() => ({
  'server:ready'() {
    process.stdout.write('NEEM_SERVER_READY\n')
  },
}))
