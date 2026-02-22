import { Injectable } from '@nestjs/common';
import { SaplConstraintHandler } from '../SaplConstraintHandler';
import { MappingConstraintHandlerProvider } from '../api/index';
import { getHandler } from './ContentFilter';

@Injectable()
@SaplConstraintHandler('mapping')
export class ContentFilteringProvider implements MappingConstraintHandlerProvider {
  isResponsible(constraint: any): boolean {
    return constraint?.type === 'filterJsonContent';
  }

  getPriority(): number {
    return 0;
  }

  getHandler(constraint: any): (value: any) => any {
    return getHandler(constraint);
  }
}
