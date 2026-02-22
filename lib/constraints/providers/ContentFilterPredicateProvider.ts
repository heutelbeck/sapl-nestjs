import { Injectable } from '@nestjs/common';
import { SaplConstraintHandler } from '../SaplConstraintHandler';
import { FilterPredicateConstraintHandlerProvider } from '../api/index';
import { predicateFromConditions } from './ContentFilter';

@Injectable()
@SaplConstraintHandler('filterPredicate')
export class ContentFilterPredicateProvider
  implements FilterPredicateConstraintHandlerProvider
{
  isResponsible(constraint: any): boolean {
    return constraint?.type === 'jsonContentFilterPredicate';
  }

  getHandler(constraint: any): (element: any) => boolean {
    return predicateFromConditions(constraint);
  }
}
