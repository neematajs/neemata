import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { ESTree } from 'rolldown/utils'
import { parseSync, Visitor } from 'rolldown/utils'

type DiscoveryNode = ESTree.Node | null | undefined

export type NeemDiscoveredImport = {
  specifier: string
  importer: string
  resolved: string
}

export type NeemDiscoveredApp = {
  name: string
  entry: NeemDiscoveredImport
  build?: NeemDiscoveredImport
  hasInlineBuild: boolean
}

export type NeemDiscoveredPlugin = {
  index: number
  entry: NeemDiscoveredImport
  build?: NeemDiscoveredImport
  hasInlineBuild: boolean
}

export type NeemConfigDiscovery = {
  configFile: string
  logger?: NeemDiscoveredImport
  hasInlineLogger: boolean
  apps: Record<string, NeemDiscoveredApp>
  plugins: NeemDiscoveredPlugin[]
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
    apps: discoverApps(configFile, configObject),
    plugins: discoverPlugins(configFile, configObject),
  }
}

function discoverLogger(
  configFile: string,
  configObject: ESTree.ObjectExpression,
): { logger?: NeemDiscoveredImport; hasInlineLogger: boolean } {
  const value = unwrapExpression(getPropertyValue(configObject, 'logger'))
  if (!value) return { hasInlineLogger: false }

  const specifier = getImportThunkSpecifier(value)
  if (specifier) {
    return {
      logger: resolveImport(configFile, specifier),
      hasInlineLogger: false,
    }
  }

  if (value.type === 'ArrowFunctionExpression') {
    throw new Error(
      `Expected logger to be a logger instance or () => import('<literal>')`,
    )
  }

  return { hasInlineLogger: true }
}

function discoverApps(
  configFile: string,
  configObject: ESTree.ObjectExpression,
) {
  const appsObject = unwrapExpression(getPropertyValue(configObject, 'apps'))

  if (!isObjectExpression(appsObject)) return {}

  const apps: Record<string, NeemDiscoveredApp> = {}

  for (const property of appsObject.properties ?? []) {
    if (!isProperty(property)) continue

    const name = getStaticPropertyName(property)
    if (!name) continue

    const appObject = unwrapConfigEntry(property.value)
    const entry = getStaticImportThunk(appObject, 'entry', configFile, name)
    const build = getOptionalStaticImportThunk(appObject, 'build', configFile)

    apps[name] = {
      name,
      entry,
      build: build?.type === 'import' ? build.value : undefined,
      hasInlineBuild: build?.type === 'inline',
    }
  }

  return apps
}

function discoverPlugins(
  configFile: string,
  configObject: ESTree.ObjectExpression,
) {
  const pluginsArray = unwrapExpression(
    getPropertyValue(configObject, 'plugins'),
  )

  if (!isArrayExpression(pluginsArray)) return []

  return (pluginsArray.elements ?? []).flatMap((element, index) => {
    const pluginObject = unwrapConfigEntry(element)
    if (!isObjectExpression(pluginObject)) return []

    const entry = getStaticImportThunk(
      pluginObject,
      'entry',
      configFile,
      `plugins[${index}]`,
    )
    const build = getOptionalStaticImportThunk(
      pluginObject,
      'build',
      configFile,
    )

    return [
      {
        index,
        entry,
        build: build?.type === 'import' ? build.value : undefined,
        hasInlineBuild: build?.type === 'inline',
      },
    ]
  })
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
):
  | { type: 'import'; value: NeemDiscoveredImport }
  | { type: 'inline' }
  | undefined {
  const value = unwrapExpression(
    getPropertyValue(objectExpression, propertyName),
  )

  if (!value) return undefined

  const specifier = getImportThunkSpecifier(value)
  if (specifier) {
    return { type: 'import', value: resolveImport(importer, specifier) }
  }

  if (isObjectExpression(value)) return { type: 'inline' }

  throw new Error(
    `Expected ${propertyName} to be an object or lazy import thunk`,
  )
}

function getImportThunkSpecifier(node: DiscoveryNode) {
  if (node?.type !== 'ArrowFunctionExpression') return undefined
  if ((node.params ?? []).length > 0) return undefined

  const body = unwrapExpression(node.body)

  if (body?.type !== 'ImportExpression') return undefined
  if (!isStringLiteral(body.source)) return undefined

  return body.source.value
}

function resolveImport(
  importer: string,
  specifier: string,
): NeemDiscoveredImport {
  return {
    specifier,
    importer,
    resolved: resolve(dirname(importer), specifier),
  }
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

function isArrayExpression(
  node: DiscoveryNode,
): node is ESTree.ArrayExpression {
  return node?.type === 'ArrayExpression'
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
