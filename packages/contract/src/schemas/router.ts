import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyProcedureContract, TProcedureContract } from './procedure.ts'
import { Kind } from '../constants.ts'
import { concatFullName, createSchema } from '../utils.ts'
import { IsProcedureContract } from './procedure.ts'

export const RouterKind = Symbol('NeemataRouter')

export type TAnyRouterContract<
  RouteContracts extends Record<string, TRouteContract> = Record<
    string,
    TRouteContract
  >,
  RouterName extends string | undefined = string | undefined,
> = TRouterContract<RouteContracts, RouterName>

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
  readonly default?: TProcedureContract<
    any,
    any,
    true | undefined,
    string | undefined
  >
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

  const routes: any = processNestedRoutes(options.routes, name)

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
  parentName: string | undefined,
): Record<string, TAnyRouterContract | TAnyProcedureContract> {
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
    } else if (IsProcedureContract(route)) {
      const fullName = concatFullName(parentName, routeName)
      processed[routeName] = createSchema({ ...route, name: fullName })
    } else {
      throw new Error(`Invalid route type for ${routeName}`)
    }
  }

  return processed
}

export function IsRouterContract(value: any): value is TAnyRouterContract {
  return Kind in value && value[Kind] === RouterKind
}
