import { Injectable } from '@nestjs/common';
import { SaplConstraintHandler } from '../SaplConstraintHandler';
import type { ConstraintHandlerProvider, ScopedHandler } from '../api/index';
import { predicateFromConditions } from './ContentFilter';

@Injectable()
@SaplConstraintHandler('provider')
export class ContentFilterPredicateProvider implements ConstraintHandlerProvider {
  getHandlers(constraint: unknown): ReadonlyArray<ScopedHandler> {
    if ((constraint as { type?: unknown })?.type !== 'jsonContentFilterPredicate') {
      return [];
    }
    const predicate = predicateFromConditions(constraint);
    return [
      {
        signal: 'output',
        priority: 0,
        shape: 'mapper',
        handler: (value) => {
          if (Array.isArray(value)) return value.filter(predicate);
          if (value === null || value === undefined) return value;
          return predicate(value) ? value : null;
        },
      },
    ];
  }
}
