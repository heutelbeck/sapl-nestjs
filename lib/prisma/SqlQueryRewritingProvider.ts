import { Injectable } from '@nestjs/common';
import { SaplConstraintHandler } from '../constraints/SaplConstraintHandler';
import type { ConstraintHandlerProvider, ScopedHandler } from '../constraints/api/index';
import { CONSTRAINT_TYPE_RELATIONAL, CONSTRAINT_TYPE_SQL, rewriteSqlQuery } from './SqlQueryRewriting';

/**
 * Constraint handler provider for the `sql:queryRewriting` (and its
 * `relational:queryRewriting` alias) obligation. Attaches a mapper to the
 * sql_query signal that narrows the Prisma operation arguments the shim
 * discharges. Register it in the application module's providers; the shim
 * extension and {@link registerPrismaShim} make the obligation admissible.
 */
@Injectable()
@SaplConstraintHandler('provider')
export class SqlQueryRewritingProvider implements ConstraintHandlerProvider {
  getHandlers(constraint: unknown): ReadonlyArray<ScopedHandler> {
    const type = (constraint as { type?: unknown })?.type;
    if (type !== CONSTRAINT_TYPE_SQL && type !== CONSTRAINT_TYPE_RELATIONAL) {
      return [];
    }
    return [
      {
        signal: 'sql_query',
        priority: 0,
        shape: 'mapper',
        handler: (args) => rewriteSqlQuery(constraint, args),
      },
    ];
  }
}
