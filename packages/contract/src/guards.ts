import { KindGuard } from '@sinclair/typebox'
import { IsEvent } from './guards/event.ts'
import { IsProcedure } from './guards/procedure.ts'
import { IsService } from './guards/service.ts'
import { IsDownStream, IsUpStream } from './guards/streams.ts'
import { IsSubscription } from './guards/subscription.ts'

export const ContractGuard = {
  ...KindGuard,
  IsEvent,
  IsSubscription,
  IsProcedure,
  IsService,
  IsDownStream,
  IsUpStream,
}
