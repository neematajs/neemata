import { ResolverFactory } from 'oxc-resolver'

const resolver = new ResolverFactory({
  conditionNames: ['import', 'module', 'node', 'default'],
  extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.node'],
  tsconfig: 'auto',
})

export function resolveImportFile(importer: string, specifier: string): string {
  const result = resolver.resolveFileSync(importer, specifier)

  if (result.path) {
    return result.path
  }

  throw new Error(
    `Failed to resolve import [${specifier}] from [${importer}]: ${result.error ?? 'unknown resolver error'}`,
  )
}
