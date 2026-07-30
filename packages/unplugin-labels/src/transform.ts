import { isAbsolute, relative } from 'node:path'

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

type Node = Record<string, any>

const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node)
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string') walk(item, visit)
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit)
    }
  }
}

// look through wrappers that do not change which call produced the injectable
const unwrap = (node: Node | null): Node | null => {
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
          callee?.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property?.name === '$withType'
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

const propertyName = (key: Node | null, computed: boolean) => {
  if (!key || computed) return undefined
  if (key.type === 'Identifier') return key.name as string
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return undefined
}

export function transformLabels(
  code: string,
  id: string,
  options: LabelsOptions = {},
): { code: string; map: any } | undefined {
  const functions = options.functions ?? DEFAULT_FUNCTIONS
  const modules = options.modules ?? DEFAULT_MODULES
  const format = options.format ?? ((name) => name)
  const withOrigin = options.origin ?? true
  const root = options.root ?? process.cwd()

  // cheap bail-out before paying for a parse
  if (!functions.some((name) => code.includes(name))) return undefined

  const filename = id.split('?')[0]
  const result = parseSync(filename, code)
  const program: Node =
    typeof result.program === 'string'
      ? JSON.parse(result.program)
      : result.program

  const locals = new Set<string>()
  const namespaces = new Set<string>()

  for (const statement of program.body ?? []) {
    if (statement.type !== 'ImportDeclaration') continue
    if (!modules.includes(statement.source?.value)) continue
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type === 'ImportSpecifier') {
        const imported = specifier.imported?.name ?? specifier.imported?.value
        if (functions.includes(imported)) locals.add(specifier.local.name)
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name)
      }
    }
  }

  if (!locals.size && !namespaces.size) return undefined

  // labels are diagnostics: a wrongly rewritten call to a same-named local
  // function would change behavior, so any shadowing disables that name
  walk(program, (node) => {
    const drop = (name?: string) => {
      if (name) {
        locals.delete(name)
        namespaces.delete(name)
      }
    }
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        drop(node.id?.name)
        break
      case 'VariableDeclarator':
        walk(node.id, (part) => {
          if (part.type === 'Identifier') drop(part.name)
        })
        break
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const param of node.params ?? []) {
          walk(param, (part) => {
            if (part.type === 'Identifier') drop(part.name)
          })
        }
        break
    }
  })

  if (!locals.size && !namespaces.size) return undefined

  const isTrackedCall = (node: Node) => {
    const { callee } = node
    if (callee?.type === 'Identifier') return locals.has(callee.name)
    if (
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object?.type === 'Identifier' &&
      namespaces.has(callee.object.name)
    ) {
      return functions.includes(callee.property?.name)
    }
    return false
  }

  const originPath = isAbsolute(filename)
    ? relative(root, filename).replaceAll('\\', '/')
    : filename

  let lineStarts: number[] | undefined
  const originOf = (offset: number) => {
    if (!lineStarts) {
      lineStarts = [0]
      for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === 10) lineStarts.push(i + 1)
      }
    }
    let line = lineStarts.length
    while (line > 1 && lineStarts[line - 1] > offset) line--
    return `${originPath}:${line}:${offset - lineStarts[line - 1] + 1}`
  }

  const source = new MagicString(code)
  const labeled = new Set<Node>()

  const tryLabel = (name: string | undefined, expression: Node | null) => {
    if (!name) return
    const call = unwrap(expression)
    if (!call || labeled.has(call) || !isTrackedCall(call)) return
    const args: Node[] = call.arguments ?? []
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
        if (node.id?.type === 'Identifier') tryLabel(node.id.name, node.init)
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
        if (node.left?.type === 'Identifier') {
          tryLabel(node.left.name, node.right)
        } else if (
          node.left?.type === 'MemberExpression' &&
          !node.left.computed
        ) {
          tryLabel(node.left.property?.name, node.right)
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
