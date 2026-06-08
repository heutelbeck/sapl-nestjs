import { Injectable } from '@nestjs/common';
import { SaplConstraintHandler } from '../constraints/SaplConstraintHandler';
import type { ConstraintHandlerProvider, ScopedHandler } from '../constraints/api/index';
import { CONSTRAINT_TYPE, rewriteMongoQuery } from './MongoQueryRewriting';

/**
 * Constraint handler provider for the `mongo:queryRewriting` obligation.
 * Attaches a mapper to the mongo_query signal that narrows the query the
 * Mongoose shim discharges. Register it in the application module's
 * providers; the shim plugin and {@link registerMongooseShim} make the
 * obligation admissible.
 */
@Injectable()
@SaplConstraintHandler('provider')
export class MongoDbQueryRewritingProvider implements ConstraintHandlerProvider {
  getHandlers(constraint: unknown): ReadonlyArray<ScopedHandler> {
    if ((constraint as { type?: unknown })?.type !== CONSTRAINT_TYPE) {
      return [];
    }
    return [
      {
        signal: 'mongo_query',
        priority: 0,
        shape: 'mapper',
        handler: (query) => rewriteMongoQuery(constraint, query),
      },
    ];
  }
}
