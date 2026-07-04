import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [
    { label: 'one', http: { listen: { hostname: '127.0.0.1', port: 4101 } } },
    { label: 'two', http: { listen: { hostname: '127.0.0.1', port: 4102 } } },
  ],
  options: { fixture: 'runtime-config' },
}))
