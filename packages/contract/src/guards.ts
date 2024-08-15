import { KindGuard } from '@sinclair/typebox'
import { IsBlob } from './guards/blob.ts'
import { IsEvent } from './guards/event.ts'
import { IsNativeEnum } from './guards/native-enum.ts'
import { IsNullable } from './guards/nullable.ts'
import { IsProcedure } from './guards/procedure.ts'
import { IsService } from './guards/service.ts'
import { IsSubscription } from './guards/subscription.ts'
import { IsUnionEnum } from './guards/union-enum.ts'

export const ContractGuard = {
  ...KindGuard,
  IsEvent,
  IsSubscription,
  IsProcedure,
  IsService,
  IsBlob,
  IsNullable,
  IsUnionEnum,
  IsNativeEnum,
}
