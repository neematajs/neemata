import { ResolverFactory } from 'oxc-resolver'

export const resolver = new ResolverFactory({
  tsconfig: 'auto',
  extensions: ['.ts', '.js', '.mjs', '.mts', '.json', '.node', '.wasm'],
  mainFields: ['module', 'main'],
})
