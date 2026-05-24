import { readFileSync } from 'node:fs'

import type { ESTree } from 'rolldown/utils'
import { ResolverFactory } from 'oxc-resolver'
import { parseSync, Visitor } from 'rolldown/utils'

type DiscoveryNode = ESTree.Node | null | undefined

const resolver = new ResolverFactory({
  conditionNames: ['import', 'module', 'node', 'default'],
  extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.node'],
  tsconfig: 'auto',
})

export type NeemDiscoveredImport = {
  specifier: string
  importer: string
  resolved: string
}

export type NeemDiscoveredRuntime = {
  name: string
  entry: NeemDiscoveredImport
  build?: NeemDiscoveredImport
  host?: { entry: NeemDiscoveredImport; build?: NeemDiscoveredImport }
}

export type NeemConfigDiscovery = {
  configFile: string
  logger?: NeemDiscoveredImport & { source: 'import' | 'specifier' }
  hasInlineLogger: boolean
  runtimes: Record<string, NeemDiscoveredRuntime>
}

export function discoverConfigEntriesSync(
  configFile: string,
  sourceText = readFileSync(configFile, 'utf8'),
): NeemConfigDiscovery {
  const parsed = parseSync(configFile, sourceText)

  if (parsed.errors.length > 0) {
    const [error] = parsed.errors
    throw new Error(
      `Failed to parse ${configFile}: ${error?.message ?? String(error)}`,
    )
  }

  const ast = parsed.program
  const configObject = findDefineConfigObject(ast)

  if (!configObject) {
    throw new Error(`Failed to find defineConfig({...}) in ${configFile}`)
  }

  return {
    configFile,
    ...discoverLogger(configFile, configObject),
    runtimes: discoverRuntimes(configFile, configObject),
  }
}

function discoverLogger(
  configFile: string,
  configObject: ESTree.ObjectExpression,
): {
  logger?: NeemDiscoveredImport & { source: 'import' | 'specifier' }
  hasInlineLogger: boolean
} {
  const value = unwrapExpression(getPropertyValue(configObject, 'logger'))
  if (!value) return { hasInlineLogger: false }

  const importSpecifier = getImportThunkSpecifier(value)
  if (importSpecifier) {
    return {
      logger: {
        ...resolveImport(configFile, importSpecifier),
        source: 'import',
      },
      hasInlineLogger: false,
    }
  }

  const moduleSpecifier = getLoggerModuleSpecifier(value)
  if (moduleSpecifier) {
    return {
      logger: {
        ...resolveImport(configFile, moduleSpecifier),
        source: 'specifier',
      },
      hasInlineLogger: false,
    }
  }

  if (value.type === 'ArrowFunctionExpression') {
    throw new Error(
      `Expected logger to be logger options, string/URL specifier, logger instance, or () => import('<literal>')`,
    )
  }

  return { hasInlineLogger: true }
}

function discoverRuntimes(
  configFile: string,
  configObject: ESTree.ObjectExpression,
) {
  const runtimesObject = unwrapExpression(
    getPropertyValue(configObject, 'runtimes'),
  )

  if (!isObjectExpression(runtimesObject)) return {}

  const runtimes: Record<string, NeemDiscoveredRuntime> = {}

  for (const property of runtimesObject.properties ?? []) {
    if (!isProperty(property)) continue

    const name = getStaticPropertyName(property)
    if (!name) {
      throw new Error('Expected runtime name to be a static property name')
    }
    if (runtimes[name]) {
      throw new Error(`Duplicate Neem runtime name [${name}]`)
    }

    const runtimeObject = unwrapConfigEntry(property.value)
    const entry = getStaticImportThunk(runtimeObject, 'entry', configFile, name)
    const build = getOptionalStaticImportThunk(
      runtimeObject,
      'build',
      configFile,
    )
    const hostValue = unwrapExpression(getPropertyValue(runtimeObject, 'host'))
    const hostSpecifier = getImportThunkSpecifier(hostValue)
    const hostObject = unwrapConfigEntry(hostValue)
    const host = hostSpecifier
      ? { entry: resolveImport(configFile, hostSpecifier) }
      : isObjectExpression(hostObject)
        ? {
            entry: getStaticImportThunk(
              hostObject,
              'entry',
              configFile,
              `${name}.host`,
            ),
            build: getOptionalStaticImportThunk(
              hostObject,
              'build',
              configFile,
            ),
          }
        : undefined

    runtimes[name] = { name, entry, build, host }
  }

  return runtimes
}

function findDefineConfigObject(ast: ESTree.Program) {
  let found: ESTree.ObjectExpression | undefined

  new Visitor({
    ExportDefaultDeclaration(node) {
      if (found) return
      const declaration = unwrapExpression(node.declaration)

      if (declaration?.type !== 'CallExpression') return
      if (!isIdentifier(declaration.callee, 'defineConfig')) return

      const [argument] = declaration.arguments ?? []
      const configObject = unwrapExpression(argument)

      if (isObjectExpression(configObject)) found = configObject
    },
  }).visit(ast)

  return found
}

function unwrapConfigEntry(node: DiscoveryNode) {
  const expression = unwrapExpression(node)

  if (expression?.type === 'CallExpression') {
    const [argument] = expression.arguments ?? []
    return unwrapExpression(argument)
  }

  return expression
}

function getStaticImportThunk(
  objectExpression: DiscoveryNode,
  propertyName: string,
  importer: string,
  owner: string,
): NeemDiscoveredImport {
  const value = unwrapExpression(
    getPropertyValue(objectExpression, propertyName),
  )
  const specifier = getImportThunkSpecifier(value)

  if (!specifier) {
    throw new Error(
      `Expected ${owner}.${propertyName} to be () => import('<literal>')`,
    )
  }

  return resolveImport(importer, specifier)
}

function getOptionalStaticImportThunk(
  objectExpression: DiscoveryNode,
  propertyName: string,
  importer: string,
): NeemDiscoveredImport | undefined {
  const value = unwrapExpression(
    getPropertyValue(objectExpression, propertyName),
  )

  if (!value) return undefined

  const specifier = getImportThunkSpecifier(value)
  if (specifier) {
    return resolveImport(importer, specifier)
  }

  throw new Error(`Expected ${propertyName} to be () => import('<literal>')`)
}

function getImportThunkSpecifier(node: DiscoveryNode) {
  if (node?.type !== 'ArrowFunctionExpression') return undefined
  if ((node.params ?? []).length > 0) return undefined

  const body = unwrapExpression(node.body)

  if (body?.type !== 'ImportExpression') return undefined
  if (!isStringLiteral(body.source)) return undefined

  return body.source.value
}

function getLoggerModuleSpecifier(node: DiscoveryNode) {
  const expression = unwrapExpression(node)

  if (isStringLiteral(expression)) return expression.value

  if (
    expression?.type === 'NewExpression' &&
    isIdentifier(expression.callee, 'URL')
  ) {
    const [specifier] = expression.arguments ?? []
    if (isStringLiteral(specifier)) return specifier.value
  }

  return undefined
}

function resolveImport(
  importer: string,
  specifier: string,
): NeemDiscoveredImport {
  return {
    specifier,
    importer,
    resolved: resolveImportFile(importer, specifier),
  }
}

function resolveImportFile(importer: string, specifier: string): string {
  const result = resolver.resolveFileSync(importer, specifier)

  if (result.path) {
    return result.path
  }

  throw new Error(
    `Failed to resolve import [${specifier}] from [${importer}]: ${result.error ?? 'unknown resolver error'}`,
  )
}

function getPropertyValue(
  objectExpression: DiscoveryNode,
  name: string,
): ESTree.Expression | undefined {
  if (!isObjectExpression(objectExpression)) return undefined

  for (const property of objectExpression.properties ?? []) {
    if (!isProperty(property)) continue
    if (getStaticPropertyName(property) === name) return property.value
  }
}

function getStaticPropertyName(property: ESTree.ObjectProperty) {
  if (property?.computed) return undefined

  if (property.key?.type === 'Identifier') return property.key.name
  if (isStringLiteral(property.key)) return property.key.value

  return undefined
}

function unwrapExpression(node: DiscoveryNode) {
  let current = node

  while (isWrappedExpression(current)) {
    current = current.expression
  }

  return current
}

function isObjectExpression(
  node: DiscoveryNode,
): node is ESTree.ObjectExpression {
  return node?.type === 'ObjectExpression'
}

function isProperty(
  node: ESTree.ObjectPropertyKind,
): node is ESTree.ObjectProperty {
  return node?.type === 'Property'
}

function isIdentifier(node: DiscoveryNode, name: string) {
  return node?.type === 'Identifier' && node.name === name
}

function isStringLiteral(node: DiscoveryNode): node is ESTree.StringLiteral {
  return node?.type === 'Literal' && typeof node.value === 'string'
}

function isWrappedExpression(
  node: DiscoveryNode,
): node is
  | ESTree.TSSatisfiesExpression
  | ESTree.TSAsExpression
  | ESTree.TSNonNullExpression
  | ESTree.ParenthesizedExpression {
  return (
    node?.type === 'TSSatisfiesExpression' ||
    node?.type === 'TSAsExpression' ||
    node?.type === 'TSNonNullExpression' ||
    node?.type === 'ParenthesizedExpression'
  )
}
