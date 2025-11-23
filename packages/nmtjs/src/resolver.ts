import { ResolverFactory } from 'oxc-resolver'

const fallback: Record<string, [string]> = {}

try {
  // oxc-resolver fails to resolve uWebSockets.js for some reason
  const mdl = 'uWebSockets.js'
  const path = import.meta.resolve(mdl)
  fallback[mdl] = [path]
} catch {}

export const resolver = new ResolverFactory({
  tsconfig: 'auto',
  extensions: ['.ts', '.js', '.mjs', '.mts', '.json', '.node'],
  fallback,
})
