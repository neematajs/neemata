import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { NeemataProxy } = require('./neemata-load-balancer.node')
export { NeemataProxy }
