import { definePluginHooks } from '@nmtjs/neem'

// The same readiness boundary for CLI and standalone production launchers.
export default definePluginHooks(({ getHealth }) => ({
  'server:ready': () => {
    process.send?.({ event: 'benchmark:ready', health: getHealth() })
  },
}))
