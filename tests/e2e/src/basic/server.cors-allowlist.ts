import { n } from 'nmtjs'

export default n.server({
  logger: { pinoOptions: { level: 'trace' } },
  applications: {
    main: {
      threads: [
        {
          ws: { listen: { port: 0, hostname: '127.0.0.1' } },
          http: {
            listen: { port: 0, hostname: '127.0.0.1' },
            cors: { origin: ['https://allowed-origin.test'] },
          },
        },
      ],
    },
  },
  metrics: {},
  proxy: {
    port: 4000,
    hostname: '127.0.0.1',
    applications: { main: { routing: { default: true } } },
  },
})
