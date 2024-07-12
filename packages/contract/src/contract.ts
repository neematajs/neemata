import { TransportType } from '@neematajs/common'
import { JsonTypeBuilder, Kind } from '@sinclair/typebox/type'
import { EventContract, type TEventContract } from './schemas/event'
import { ProcedureContract, type TProcedureContract } from './schemas/procedure'
import { ServiceContract, type TServiceContract } from './schemas/service'
import {
  SubscriptionContract,
  type TSubscriptionContract,
} from './schemas/subscription'
import { type TUnionEnum, UnionEnum } from './schemas/union'

import './formats' // register ajv formats

const Contract = Object.freeze(
  Object.assign(new JsonTypeBuilder(), {
    Procedure: ProcedureContract,
    Event: EventContract,
    Subscription: SubscriptionContract,
    Service: ServiceContract,
    Union: UnionEnum,
  }),
)

export const DashboardServiceContract = Contract.Service(
  'Dashboard',
  { [TransportType.WS]: true, [TransportType.HTTP]: true },
  {
    getDashboard: Contract.Procedure(
      Contract.Object({ a: Contract.String() }),
      Contract.Object({ a: Contract.String() }),
    ),
    chat: Contract.Procedure(
      Contract.Object({ b: Contract.String() }),
      Contract.Subscription(Contract.Object({}), {
        message: Contract.String(),
        join: Contract.Object({
          a: Contract.String(),
        }),
        leave: Contract.Object({
          b: Contract.Number(),
        }),
      }),
    ),
  },
  {
    closePlayer: Contract.Event(Contract.Object({ a: Contract.String() })),
  },
  60000,
  {
    title: 'Dashboard service contract',
    description: 'This is a contract for the dashboard service',
  },
)

export const AnotherServiceContract = Contract.Service(
  'Anotjer',
  { [TransportType.WS]: true, [TransportType.HTTP]: true },
  {
    // getDashboard: Contract.Procedure(
    //   Contract.Object({ a: Contract.String() }),
    //   Contract.Object({ a: Contract.String() }),
    // ),
    // getVals: Contract.Procedure(
    //   Contract.Object({ b: Contract.String() }),
    //   Contract.Subscription(
    //     Contract.Object({}),
    //     Contract.Object({ c: Contract.String() }),
    //   ),
    // ),
  },
  {
    closePlayer: Contract.Event(Contract.Object({ a: Contract.String() })),
  },
  60000,
  {
    title: 'Dashboard service contract',
    description: 'This is a contract for the dashboard service',
  },
)

export {
  Contract,
  Kind,
  type TUnionEnum,
  type TEventContract,
  type TProcedureContract,
  type TServiceContract,
  type TSubscriptionContract,
}
