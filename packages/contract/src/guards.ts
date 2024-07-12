import { KindGuard } from '@sinclair/typebox'
import { IsEvent } from './guards/event'
import { IsProcedure } from './guards/procedure'
import { IsService } from './guards/service'
import { IsSubscription } from './guards/subscription'

export const ContractGuard = {
  ...KindGuard,
  IsEvent,
  IsSubscription,
  IsProcedure,
  IsService,
}
