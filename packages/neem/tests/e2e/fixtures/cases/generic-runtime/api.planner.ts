import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [
    { label: 'one', http: { listen: { hostname: '127.0.0.1', port: 4201 } } },
    { label: 'two', http: { listen: { hostname: '127.0.0.1', port: 4202 } } },
  ],
}))
