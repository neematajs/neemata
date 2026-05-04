import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { parseSync } from 'rolldown/utils'

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
    apps: discoverApps(configFile, configObject),
    plugins: discoverPlugins(configFile, configObject),
  }
}

function discoverApps(
  configFile: string,
  configObject: any,
): Record<string, NeemDiscoveredApp> {
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
  configObject: any,
): NeemDiscoveredPlugin[] {
  const pluginsArray = unwrapExpression(
    getPropertyValue(configObject, 'plugins'),
  )

  if (!pluginsArray || pluginsArray.type !== 'ArrayExpression') return []

  return (pluginsArray.elements ?? []).flatMap(
    (element: any, index: number) => {
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
    },
  )
}

function findDefineConfigObject(ast: any): any | undefined {
  let found: any

  visit(ast, (node) => {
    if (found || node?.type !== 'CallExpression') return
    if (!isIdentifier(node.callee, 'defineConfig')) return

    const [argument] = node.arguments ?? []
    const configObject = unwrapExpression(argument)

    if (isObjectExpression(configObject)) found = configObject
  })

  return found
}

function unwrapConfigEntry(node: any): any {
  const expression = unwrapExpression(node)

  if (expression?.type === 'CallExpression') {
    const [argument] = expression.arguments ?? []
    return unwrapExpression(argument)
  }

  return expression
}

function getStaticImportThunk(
  objectExpression: any,
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
  objectExpression: any,
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

function getImportThunkSpecifier(node: any): string | undefined {
  if (node?.type !== 'ArrowFunctionExpression') return undefined
  if ((node.params ?? []).length > 0) return undefined

  const body = unwrapExpression(node.body)

  if (body?.type !== 'ImportExpression') return undefined
  if (typeof body.source?.value !== 'string') return undefined

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

function getPropertyValue(objectExpression: any, name: string): any {
  if (!isObjectExpression(objectExpression)) return undefined

  return (objectExpression.properties ?? []).find(
    (property: any) =>
      isProperty(property) && getStaticPropertyName(property) === name,
  )?.value
}

function getStaticPropertyName(property: any): string | undefined {
  if (property?.computed) return undefined

  if (property.key?.type === 'Identifier') return property.key.name
  if (typeof property.key?.value === 'string') return property.key.value

  return undefined
}

function unwrapExpression(node: any): any {
  let current = node

  while (
    current?.type === 'TSSatisfiesExpression' ||
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSNonNullExpression' ||
    current?.type === 'ParenthesizedExpression'
  ) {
    current = current.expression
  }

  return current
}

function isObjectExpression(node: any): boolean {
  return node?.type === 'ObjectExpression'
}

function isProperty(node: any): boolean {
  return node?.type === 'Property'
}

function isIdentifier(node: any, name: string): boolean {
  return node?.type === 'Identifier' && node.name === name
}

function visit(node: any, visitor: (node: any) => void): void {
  if (!node || typeof node !== 'object') return

  visitor(node)

  for (const value of Object.values(node)) {
    if (!value) continue

    if (Array.isArray(value)) {
      for (const item of value) visit(item, visitor)
      continue
    }

    if (typeof value === 'object') visit(value, visitor)
  }
}
