import { defineConfig } from 'vite'

// The define proves the app config file is loaded and re-applied by the
// neem-vite preset (which passes configFile: false to vite) rather than
// being ignored.
export default defineConfig({
  define: {
    __CONFIG_TAG__: JSON.stringify('loaded-from-vite-config'),
  },
})
