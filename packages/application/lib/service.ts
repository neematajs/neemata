import assert from 'node:assert'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type TEventContract, type TServiceContract, c } from '@nmtjs/contract'
import type { BaseType } from '@nmtjs/type'
import { Hook, kProcedure, kService } from './constants.ts'
import { Hooks } from './hooks.ts'
import type { AnyBaseProcedure, AnyGuard, AnyMiddleware } from './procedure.ts'
import type { Callback } from './types.ts'

export interface Service<Contract extends TServiceContract = TServiceContract> {
  contract: Contract
  procedures: Map<string, AnyBaseProcedure>
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  hooks: Hooks
  [kService]: any
}

export type AnyService = Service

export function createContractService<
  Contract extends TServiceContract = TServiceContract,
>(
  contract: Contract,
  params: {
    procedures?: Record<string, AnyBaseProcedure>
    guards?: AnyGuard[]
    middlewares?: AnyMiddleware[]
    hooks?: Record<string, Callback[]>
    autoload?: string | URL
  },
): Service<Contract> {
  const guards = new Set(params.guards ?? [])
  const middlewares = new Set(params.middlewares ?? [])
  const procedures = new Map(Object.entries(params.procedures ?? {}))
  const hooks = new Hooks()

  for (const [hookName, callbacks] of Object.entries(params.hooks ?? {})) {
    for (const hook of callbacks) {
      hooks.add(hookName, hook)
    }
  }

  const service = {
    contract,
    procedures,
    guards,
    middlewares,
    hooks,
    [kService]: true,
  }

  if (params.autoload) {
    const dirpath =
      params.autoload instanceof URL
        ? fileURLToPath(params.autoload)
        : params.autoload
    hooks.add(
      Hook.BeforeInitialize,
      createAutoLoader(path.resolve(dirpath), service),
    )
  }

  return service
}

const createAutoLoader =
  (directory: string, service: AnyService) => async () => {
    const procedureNames = Object.keys(service.contract.procedures)
    const extensions = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']
    const ignore = ['.d.ts', '.d.mts', '.d.cts']
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (ignore.some((ext) => entry.name.endsWith(ext))) continue
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
      const procedureName = path.parse(
        path.join(entry.parentPath, entry.name),
      ).name
      if (!procedureNames.includes(procedureName)) continue
      const filepath = path.join(entry.parentPath, entry.name)
      let implementation: any = null
      // TODO: this might be not very reliable way
      // to distinguish between ESM and CJS modules
      if (typeof module === 'undefined') {
        implementation = await import(filepath).then((m) => m.default)
      } else {
        implementation = require(filepath)
      }
      assert(kProcedure in implementation, 'Invalid procedure')
      service.procedures.set(procedureName, implementation as any)
    }
  }

export function createService<
  Name extends string,
  Transports extends { [K in string]: true },
  Procedures extends Record<string, AnyBaseProcedure> = {},
  Events extends Record<string, BaseType> = {},
>(params: {
  name: Name
  transports: Transports
  procedures?: Procedures
  events?: Events
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  hooks?: Record<string, Callback[]>
}): Service<
  TServiceContract<
    Name,
    Transports,
    {
      [K in keyof Procedures]: Procedures[K]['contract']
    },
    {
      [K in keyof Events]: TEventContract<Events[K]>
    }
  >
> {
  const { name, transports, guards, hooks, middlewares } = params
  const procedures = params.procedures ?? ({} as Procedures)
  const events = params.events ?? ({} as Events)

  const eventsContracts: any = {}
  for (const [name, type] of Object.entries(events)) {
    eventsContracts[name] = c.event(type)
  }

  const proceduresContracts: any = {}
  for (const [name, procedure] of Object.entries(procedures)) {
    proceduresContracts[name] = procedure.contract
  }

  const contract = c.service(
    name,
    transports,
    proceduresContracts,
    eventsContracts,
  )

  for (const [name, procedureContract] of Object.entries(contract.procedures)) {
    // @ts-expect-error
    procedures[name] = {
      ...procedures[name],
      contract: procedureContract,
    }
  }

  const service = createContractService(contract, {
    procedures,
    guards,
    hooks,
    middlewares,
  })

  return service
}
