import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyEventContract } from './event.ts'
import type { TAnyProcedureContract, TProcedureContract } from './procedure.ts'
import { Kind } from '../constants.ts'
import { concatFullName, createSchema } from '../utils.ts'

export const RouterKind = Symbol('NeemataRouter')

export type TAnyRouterContract<
  RouteContracts extends Record<string, TRouteContract> = Record<
    string,
    TRouteContract
  >,
> = TRouterContract<RouteContracts, string | undefined>

export type TRouteContract =
  | TAnyProcedureContract
  | TRouterContract<Record<string, TRouteContract>, string | undefined>

export interface TRouterContract<
  Routes extends Record<string, TRouteContract> = {},
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof RouterKind
  readonly type: 'neemata:router'
  readonly name: Name
  readonly routes: {
    [K in keyof Routes]: Routes[K] extends TAnyRouterContract
      ? TRouterContract<
          Routes[K]['routes'],
          Name extends string
            ? `${Name}/${Extract<K, string>}`
            : Extract<K, string>
        >
      : Routes[K] extends TAnyProcedureContract
        ? TProcedureContract<
            Routes[K]['input'],
            Routes[K]['output'],
            Routes[K]['stream'],
            Name extends string
              ? `${Name}/${Extract<K, string>}`
              : Extract<K, string>
          >
        : never
  }
  readonly timeout?: number
}

export const RouterContract = <
  const Options extends {
    routes: Record<string, TRouteContract>
    events?: Record<string, TAnyEventContract>
    name?: string
    timeout?: number
    schemaOptions?: ContractSchemaOptions
  },
>(
  options: Options,
) => {
  const {
    name = undefined as any,
    timeout,
    schemaOptions = {} as ContractSchemaOptions,
  } = options
  const events: any = {}

  for (const eventName in options.events || {}) {
    const event = options.events![eventName]
    const fullName = concatFullName(name, eventName)
    events[eventName] = createSchema({
      ...event,
      subscription: undefined,
      name: fullName,
    })
  }

  const routes: any = {}

  for (const routeName in options.routes) {
    const route: any = options.routes[routeName]

    if (IsRouterContract(route)) {
      const nestedName = concatFullName(name, routeName)
      routes[routeName] = createSchema({
        ...route,
        name: nestedName,
        routes: processNestedRoutes(route.routes, nestedName),
      })
    } else {
      const fullName = concatFullName(name, routeName)
      routes[routeName] = createSchema({ ...route, name: fullName })
    }
  }

  return createSchema<
    TRouterContract<
      Options['routes'],
      Options['name'] extends string ? Options['name'] : undefined
    >
  >({
    ...schemaOptions,
    [Kind]: RouterKind,
    type: 'neemata:router',
    name,
    routes,
    timeout,
  })
}

function processNestedRoutes(
  routes: Record<string, TAnyRouterContract | TAnyProcedureContract>,
  parentName: string,
): Record<string, any> {
  const processed: Record<string, any> = {}

  for (const routeName in routes) {
    const route = routes[routeName]

    if (IsRouterContract(route)) {
      const nestedName = concatFullName(parentName, routeName)
      processed[routeName] = createSchema({
        ...route,
        name: nestedName,
        routes: processNestedRoutes(route.routes, nestedName),
      })
    } else {
      const fullName = concatFullName(parentName, routeName)
      processed[routeName] = createSchema({ ...route, name: fullName })
    }
  }

  return processed
}

export function IsRouterContract(value: any): value is TAnyRouterContract {
  return Kind in value && value[Kind] === RouterKind
}
