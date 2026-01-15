import { n } from 'nmtjs'

export default n.server({
  logger: { pinoOptions: { level: 'trace' } },
  applications: {
    main: {
      threads: [{ ws: { listen: { port: 4000, hostname: '127.0.0.1' } } }],
    },
  },
  metrics: {},
})
