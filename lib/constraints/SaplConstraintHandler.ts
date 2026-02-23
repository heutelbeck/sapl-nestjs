import { DiscoveryService } from '@nestjs/core';

export type ConstraintHandlerType =
  | 'runnable'
  | 'consumer'
  | 'mapping'
  | 'errorHandler'
  | 'errorMapping'
  | 'filterPredicate'
  | 'methodInvocation'
  | 'subscription'
  | 'request';

export const SaplConstraintHandler =
  DiscoveryService.createDecorator<ConstraintHandlerType>();
