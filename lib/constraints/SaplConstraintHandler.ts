import { DiscoveryService } from '@nestjs/core';

export type ConstraintHandlerType = 'provider';

export const SaplConstraintHandler = DiscoveryService.createDecorator<ConstraintHandlerType>();
