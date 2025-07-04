import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Callback } from '@nmtjs/common'
import {
  c,
  type TAnyNamespaceContract,
  type TEventContract,
  type TNamespaceContract,
} from '@nmtjs/contract'
import { Hook, Hooks } from '@nmtjs/core'
import type { BaseType } from '@nmtjs/type'
import type { AnyGuard, AnyMiddleware } from './api.ts'
import { kNamespace, kProcedure } from './constants.ts'
import type { AnyProcedure } from './procedure.ts'

export interface Namespace<Contract extends TAnyNamespaceContract> {
  contract: Contract
  procedures: Map<string, AnyProcedure>
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  hooks: Hooks
  [kNamespace]: any
}

export type AnyNamespace = Namespace<TAnyNamespaceContract>

export function createContractNamespace<Contract extends TAnyNamespaceContract>(
  contract: Contract,
  params: {
    procedures?: Record<string, AnyProcedure>
    guards?: AnyGuard[]
    middlewares?: AnyMiddleware[]
    hooks?: Record<string, Callback[]>
    autoload?: string | URL
  },
): Namespace<Contract> {
  const guards = new Set(params.guards ?? [])
  const middlewares = new Set(params.middlewares ?? [])
  const procedures = new Map(Object.entries(params.procedures ?? {}))
  const hooks = new Hooks()

  for (const [hookName, callbacks] of Object.entries(params.hooks ?? {})) {
    for (const hook of callbacks) {
      hooks.add(hookName, hook)
    }
  }

  const namespace = {
    contract,
    procedures,
    guards,
    middlewares,
    hooks,
    [kNamespace]: true,
  }

  if (params.autoload) {
    const dirpath =
      params.autoload instanceof URL
        ? fileURLToPath(params.autoload)
        : params.autoload
    hooks.add(
      Hook.BeforeInitialize,
      createAutoLoader(path.resolve(dirpath), namespace),
    )
  }

  return namespace
}

const createAutoLoader =
  (directory: string, namespace: AnyNamespace) => async () => {
    const { procedures } = namespace.contract
    const extensions = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']
    const ignore = ['.d.ts', '.d.mts', '.d.cts']
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (ignore.some((ext) => entry.name.endsWith(ext))) continue
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
      const filepath = path.join(entry.parentPath, entry.name)
      const procedureName = path.parse(filepath).name
      if (procedureName in procedures === false) continue
      let implementation: any = null
      // TODO: this might be not very reliable way
      // to distinguish between ESM and CJS modules
      if (typeof module === 'undefined') {
        implementation = await import(filepath).then((m) => m.default)
      } else {
        implementation = require(filepath)
      }

      if (kProcedure in implementation) {
        namespace.procedures.set(procedureName, implementation as any)
      } else {
        throw new Error(`Invalid procedure or subscription export: ${filepath}`)
      }
    }
  }

export function createNamespace<
  Name extends string,
  Procedures extends Record<string, AnyProcedure> = {},
  Events extends Record<string, BaseType> = {},
>(params: {
  name: Name
  procedures?: Procedures
  events?: Events
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  hooks?: Record<string, Callback[]>
  timeout?: number
}): Namespace<
  TNamespaceContract<
    {
      [K in keyof Procedures]: Procedures[K]['contract']
    },
    {
      [K in Extract<keyof Events, string>]: TEventContract<Events[K], K, Name>
    },
    Name
  >
> {
  const { name, guards, hooks, middlewares, timeout } = params
  const procedures = params.procedures ?? ({} as Procedures)
  const events = params.events ?? ({} as Events)

  const eventsContracts: any = {}
  for (const [name, type] of Object.entries(events)) {
    eventsContracts[name] = c.event({ payload: type })
  }

  const proceduresContracts: any = {}
  for (const [name, procedure] of Object.entries(procedures)) {
    proceduresContracts[name] = procedure.contract
  }

  const contract = c.namespace({
    procedures: proceduresContracts,
    events: eventsContracts,
    timeout,
    name,
  })

  for (const [name, procedureContract] of Object.entries(contract.procedures)) {
    // @ts-expect-error
    procedures[name] = {
      ...procedures[name],
      contract: procedureContract,
    }
  }

  const namespace = createContractNamespace(contract, {
    procedures,
    guards,
    hooks,
    middlewares,
  })

  return namespace as any
}
