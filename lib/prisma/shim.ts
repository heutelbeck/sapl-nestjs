import type { ClsService } from 'nestjs-cls';
import { activePlan } from '../constraints/ActivePlan';
import { registerShimSignal, unregisterShimSignal } from '../constraints/ShimSignalRegistry';
import { AccessDeniedError } from '../streaming/BoundarySignals';
import { SQL_QUERY, SQL_QUERY_OBLIGATION_FAILURE, SQL_QUERY_UNNARROWABLE_OPERATION } from './signal';

/** Read/write operations whose `where` is a row-selecting filter the obligation can narrow. */
const NARROWABLE_OPERATIONS = new Set([
  'aggregate',
  'count',
  'deleteMany',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'groupBy',
  'updateMany',
]);

/**
 * Operations whose `where` is a unique-key selector. With an obligation
 * active these cannot be AND-narrowed (Prisma rejects a compound where on
 * a unique lookup), so they fail closed.
 */
const UNIQUE_KEY_OPERATIONS = new Set(['delete', 'findUnique', 'findUniqueOrThrow', 'update', 'upsert']);

type OperationArgs = Record<string, unknown>;
type QueryFn = (args: OperationArgs) => Promise<unknown>;
interface OperationContext {
  readonly operation: string;
  readonly args: OperationArgs;
  readonly query: QueryFn;
}

/** Advertise the sql_query signal so its obligations are admitted. Idempotent. */
export const registerPrismaShim = (): void => registerShimSignal(SQL_QUERY);

/** Withdraw the sql_query signal. Idempotent. */
export const unregisterPrismaShim = (): void => unregisterShimSignal(SQL_QUERY);

const discharge = (cls: ClsService, args: OperationArgs): OperationArgs => {
  const plan = activePlan(cls);
  if (!plan || plan.entriesFor(SQL_QUERY).length === 0) return args;
  const result = plan.execute({ kind: 'sql_query', value: args });
  if (result.failureState) throw new AccessDeniedError(SQL_QUERY_OBLIGATION_FAILURE);
  return (result.value.kind === 'present' ? result.value.value : args) as OperationArgs;
};

/**
 * Prisma Client extension that narrows reads and bulk writes against the
 * active enforcement plan. Apply it with
 * `prisma.$extends(createSaplPrismaExtension(cls))` and call
 * {@link registerPrismaShim} once at startup. The plan is read from the
 * request-scoped CLS context populated by the PreEnforce PEP, so a
 * `sql:queryRewriting` obligation transparently constrains the rows the
 * enforced handler reads or mutates.
 *
 * Filter operations have their arguments narrowed by the obligation
 * handler. Unique-key operations fail closed when an obligation is active,
 * since a unique selector cannot be AND-narrowed. Operations without a
 * filter (create, createMany) pass through.
 *
 * @param cls the request-scoped CLS service holding the active plan
 */
export const createSaplPrismaExtension = (cls: ClsService) => ({
  name: 'sapl-sql-query-manipulation',
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }: OperationContext): Promise<unknown> {
        const plan = activePlan(cls);
        const enforced = !!plan && plan.entriesFor(SQL_QUERY).length > 0;
        if (!enforced) return query(args);
        if (UNIQUE_KEY_OPERATIONS.has(operation)) {
          throw new AccessDeniedError(SQL_QUERY_UNNARROWABLE_OPERATION);
        }
        if (!NARROWABLE_OPERATIONS.has(operation)) return query(args);
        return query(discharge(cls, args));
      },
    },
  },
});
