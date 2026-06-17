const { defineRuntime } = require('@nmtjs/neem')

module.exports = defineRuntime({
  name: 'cjs-cts-convention',
  worker: { entry: '../../../shared/workers/runtime-app.ts' },
})
