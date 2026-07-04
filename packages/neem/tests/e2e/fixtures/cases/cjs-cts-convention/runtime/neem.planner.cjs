const { defineRuntimePlanner } = require(
  `${process.cwd()}/dist/public/index.js`,
)

module.exports = defineRuntimePlanner(() => ({
  workers: [{ label: 'cjs-cts-convention' }],
  options: { fixture: 'cjs-cts-convention' },
}))
