import { isAbsolute, relative } from 'node:path'

import type { SourceMap } from 'magic-string'
import type {
  CallExpression,
  Node,
  Program,
  PropertyKey as PropertyKeyNode,
} from 'oxc-parser'
import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'

export type LabelsOptions = {
  /** Import sources whose creator functions should be labeled. */
  modules?: string[]
  /** Exported creator names to track (label is their second argument). */
  functions?: string[]
  /** Customize the injected label, e.g. prefix it with the module name. */
  format?: (name: string, id: string) => string
  /**
   * Inject the declaration site (`file:line:col`) as the creator's third
   * argument, so locations survive bundling without sourcemaps. Enabled by
   * default.
   */
  origin?: boolean
  /** Base directory the injected origin paths are made relative to. */
  root?: string
}

export const DEFAULT_MODULES = ['@nmtjs/core', '@nmtjs/application', 'nmtjs']

export const DEFAULT_FUNCTIONS = [
  'createFactoryInjectable',
  'createLazyInjectable',
  'createValueInjectable',
  'factory',
  'lazy',
  'value',
]

/** Creator names reachable in this module, by how they were imported. */
type Tracked = { locals: Set<string>; namespaces: Set<string> }

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string'

const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node)
  const values: unknown[] = Object.values(node)
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) walk(item, visit)
      }
    } else if (isNode(value)) {
      walk(value, visit)
    }
  }
}

// look through wrappers that do not change which call produced the injectable
const unwrap = (node: Node | null): CallExpression | null => {
  let current = node
  while (current) {
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSInstantiationExpression':
      case 'ParenthesizedExpression':
        current = current.expression
        continue
      case 'CallExpression': {
        // const db = lazy().$withType<Db>() — label the inner creator call
        const { callee } = current
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.name === '$withType'
        ) {
          current = callee.object
          continue
        }
        return current
      }
      default:
        return null
    }
  }
  return null
}

const propertyName = (key: PropertyKeyNode, computed: boolean) => {
  if (computed) return undefined
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return undefined
}

function collectTracked(
  program: Program,
  modules: string[],
  functions: string[],
): Tracked {
  const locals = new Set<string>()
  const namespaces = new Set<string>()

  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    if (!modules.includes(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const { imported } = specifier
        const name =
          imported.type === 'Identifier' ? imported.name : imported.value
        if (functions.includes(name)) locals.add(specifier.local.name)
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name)
      }
    }
  }

  return { locals, namespaces }
}

// labels are diagnostics: a wrongly rewritten call to a same-named local
// function would change behavior, so any shadowing disables that name
function dropShadowed(program: Program, tracked: Tracked): void {
  const drop = (name: string | undefined) => {
    if (!name) return
    tracked.locals.delete(name)
    tracked.namespaces.delete(name)
  }
  const dropBound = (pattern: Node) => {
    walk(pattern, (part) => {
      if (part.type === 'Identifier') drop(part.name)
    })
  }

  walk(program, (node) => {
    switch (node.type) {
      case 'ClassDeclaration':
        drop(node.id?.name)
        break
      case 'VariableDeclarator':
        dropBound(node.id)
        break
      case 'FunctionDeclaration':
        drop(node.id?.name)
        for (const param of node.params) dropBound(param)
        break
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const param of node.params) dropBound(param)
        break
      case 'CatchClause':
        if (node.param) dropBound(node.param)
        break
    }
  })
}

function isTracked(
  call: CallExpression,
  tracked: Tracked,
  functions: string[],
): boolean {
  const { callee } = call
  if (callee.type === 'Identifier') return tracked.locals.has(callee.name)
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    tracked.namespaces.has(callee.object.name)
  ) {
    return functions.includes(callee.property.name)
  }
  return false
}

// the table is built on first use: only labeled calls need a position, a
// handful per module
function createOrigin(code: string, path: string) {
  let lineStarts: number[] | undefined
  return (offset: number) => {
    if (!lineStarts) {
      lineStarts = [0]
      for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === 10) lineStarts.push(i + 1)
      }
    }
    let line = lineStarts.length
    while (line > 1 && lineStarts[line - 1] > offset) line--
    return `${path}:${line}:${offset - lineStarts[line - 1] + 1}`
  }
}

export function transformLabels(
  code: string,
  id: string,
  options: LabelsOptions = {},
): { code: string; map: SourceMap } | undefined {
  const functions = options.functions ?? DEFAULT_FUNCTIONS
  const modules = options.modules ?? DEFAULT_MODULES
  const format = options.format ?? ((name) => name)
  const withOrigin = options.origin ?? true
  const root = options.root ?? process.cwd()

  // cheap bail-out before paying for a parse
  if (!functions.some((name) => code.includes(name))) return undefined

  const filename = id.split('?')[0]
  const { program } = parseSync(filename, code)

  const tracked = collectTracked(program, modules, functions)
  if (!tracked.locals.size && !tracked.namespaces.size) return undefined

  dropShadowed(program, tracked)
  if (!tracked.locals.size && !tracked.namespaces.size) return undefined

  const originPath = isAbsolute(filename)
    ? relative(root, filename).replaceAll('\\', '/')
    : filename
  const originOf = createOrigin(code, originPath)

  const source = new MagicString(code)
  const labeled = new Set<CallExpression>()

  const tryLabel = (name: string | undefined, expression: Node | null) => {
    if (!name) return
    const call = unwrap(expression)
    if (!call || labeled.has(call)) return
    if (!isTracked(call, tracked, functions)) return
    const args = call.arguments
    // explicit arguments always win; spreads make positions unknowable
    if (args.length >= (withOrigin ? 3 : 2)) return
    if (args.some((arg) => arg.type === 'SpreadElement')) return
    labeled.add(call)

    const parts: string[] = []
    if (args.length < 2) parts.push(JSON.stringify(format(name, id)))
    if (withOrigin) parts.push(JSON.stringify(originOf(call.start)))

    if (args.length === 0) {
      source.appendLeft(call.end - 1, `undefined, ${parts.join(', ')}`)
    } else {
      source.appendLeft(args[args.length - 1].end, `, ${parts.join(', ')}`)
    }
  }

  walk(program, (node) => {
    switch (node.type) {
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier') tryLabel(node.id.name, node.init)
        break
      case 'PropertyDefinition':
        tryLabel(propertyName(node.key, node.computed), node.value)
        break
      case 'Property':
        if (node.kind === 'init' && !node.shorthand) {
          tryLabel(propertyName(node.key, node.computed), node.value)
        }
        break
      case 'AssignmentExpression':
        if (node.operator !== '=') break
        if (node.left.type === 'Identifier') {
          tryLabel(node.left.name, node.right)
        } else if (
          node.left.type === 'MemberExpression' &&
          !node.left.computed
        ) {
          tryLabel(node.left.property.name, node.right)
        }
        break
    }
  })

  if (!labeled.size) return undefined

  return {
    code: source.toString(),
    map: source.generateMap({ hires: true }),
  }
}
