import assert from 'node:assert'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TServiceContract } from '@nmtjs/contract'
import { Hook, ProcedureKey, ServiceKey } from './constants.ts'
import { Hooks } from './hooks.ts'
import type { AnyGuard, AnyMiddleware, AnyProcedure } from './procedure.ts'
import type { Callback } from './types.ts'

export interface Service<Contract extends TServiceContract = TServiceContract> {
  contract: Contract
  procedures: Map<string, AnyProcedure>
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  hooks: Hooks
  [ServiceKey]: any
}

export type AnyService = Service

export function createContractService<
  Contract extends TServiceContract = TServiceContract,
>(
  contract: Contract,
  params: {
    procedures?: Record<string, AnyProcedure>
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
    [ServiceKey]: true,
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
    // TODO: this might be not very reliable
      if (typeof module === 'undefined') {
        implementation = await import(filepath).then((m) => m.default)
      } else {
        implementation = require(filepath)
      }
      assert(ProcedureKey in implementation, 'Invalid procedure')
      service.procedures.set(procedureName, implementation as any)
    }
  }
