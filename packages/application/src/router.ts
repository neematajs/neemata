import {
  c,
  type TAnyAPIContract,
  type TAPIContract,
  type TNamespaceContract,
} from '@nmtjs/contract'
import type { AnyNamespace, Namespace } from './namespace.ts'

export type AnyRouter = Router<TAnyAPIContract>

export interface Router<Contract extends TAnyAPIContract> {
  contract: Contract
  namespaces: {
    [K in keyof Contract['namespaces']]: Namespace<
      TNamespaceContract<
        Contract['namespaces'][K]['procedures'],
        Contract['namespaces'][K]['events'],
        Extract<K, string>
      >
    >
  }
  timeout?: number
}

export function createContractRouter<Contract extends TAnyAPIContract>(
  contract: Contract,
  namespaces: {
    [K in keyof Contract['namespaces']]: Namespace<
      TNamespaceContract<
        Contract['namespaces'][K]['procedures'],
        Contract['namespaces'][K]['events'],
        any
      >
    >
  },
): Router<Contract> {
  return {
    contract,
    namespaces,
    timeout: contract.timeout,
  }
}

export function createRouter<Namespaces extends Record<string, AnyNamespace>>(
  namespaces: Namespaces,
  options: { timeout?: number } = {},
): Router<
  TAPIContract<{
    [K in keyof Namespaces]: TNamespaceContract<
      Namespaces[K]['contract']['procedures'],
      Namespaces[K]['contract']['events'],
      Extract<K, string>
    >
  }>
> {
  const contracts = {} as any

  for (const [name, namespace] of Object.entries(namespaces)) {
    contracts[name] = namespace.contract
  }

  return createContractRouter(
    c.api({ namespaces: contracts, timeout: options.timeout }),
    namespaces,
  )
}
