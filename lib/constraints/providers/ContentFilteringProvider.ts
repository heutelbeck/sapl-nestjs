import { Injectable } from '@nestjs/common';
import { SaplConstraintHandler } from '../SaplConstraintHandler';
import type { ConstraintHandlerProvider, ScopedHandler } from '../api/index';
import { getHandler } from './ContentFilter';

@Injectable()
@SaplConstraintHandler('provider')
export class ContentFilteringProvider implements ConstraintHandlerProvider {
  getHandlers(constraint: unknown): ReadonlyArray<ScopedHandler> {
    if ((constraint as { type?: unknown })?.type !== 'filterJsonContent') {
      return [];
    }
    const transform = getHandler(constraint);
    return [
      {
        signal: 'output',
        priority: 0,
        shape: 'mapper',
        handler: (value) => transform(value),
      },
    ];
  }
}
