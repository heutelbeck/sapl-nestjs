import type { Aggregate, MongooseQueryMiddleware, Query, Schema } from 'mongoose';
import type { ClsService } from 'nestjs-cls';
import { activePlan } from '../constraints/ActivePlan';
import { registerShimSignal, unregisterShimSignal } from '../constraints/ShimSignalRegistry';
import { AccessDeniedError } from '../streaming/BoundarySignals';
import { MONGO_QUERY, MONGO_QUERY_OBLIGATION_FAILURE } from './signal';

/**
 * Query operations whose first criterion is a filter the obligation can
 * narrow. Each fires Mongoose query middleware where `this` is the
 * Query and exposes the filter via getFilter/setQuery.
 */
const FILTER_OPERATIONS: MongooseQueryMiddleware[] = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

/** Advertise the mongo_query signal so its obligations are admitted. Idempotent. */
export const registerMongooseShim = (): void => registerShimSignal(MONGO_QUERY);

/** Withdraw the mongo_query signal. Idempotent. */
export const unregisterMongooseShim = (): void => unregisterShimSignal(MONGO_QUERY);

/**
 * Discharge a query value through the active plan's mongo_query
 * handlers. Returns the value unchanged when no plan is in scope or no
 * mongo_query handler is attached. Throws fail-closed when an
 * obligation handler reports failure.
 */
const discharge = (cls: ClsService, value: unknown): unknown => {
  const plan = activePlan(cls);
  if (!plan || plan.entriesFor(MONGO_QUERY).length === 0) return value;
  const result = plan.execute({ kind: 'mongo_query', value });
  if (result.failureState) throw new AccessDeniedError(MONGO_QUERY_OBLIGATION_FAILURE);
  return result.value.kind === 'present' ? result.value.value : value;
};

/**
 * Mongoose plugin that narrows reads and writes against the active
 * enforcement plan. Apply it to a schema, or globally via
 * `mongoose.plugin(createSaplMongoosePlugin(cls))`, and call
 * {@link registerMongooseShim} once at startup. The plan is read from
 * the request-scoped CLS context populated by the PreEnforce PEP, so a
 * `mongo:queryRewriting` obligation transparently constrains the data
 * the enforced handler reads.
 *
 * Filter operations have their filter replaced with the narrowed
 * result. An aggregation pipeline is passed to the handler too; since a
 * pipeline cannot be narrowed by an AND-merge the handler rejects it,
 * which surfaces here as fail-closed denial.
 *
 * @param cls the request-scoped CLS service holding the active plan
 */
export const createSaplMongoosePlugin =
  (cls: ClsService) =>
  (schema: Schema): void => {
    schema.pre(FILTER_OPERATIONS, function (this: Query<unknown, unknown>) {
      this.setQuery(discharge(cls, this.getFilter()) as Record<string, unknown>);
    });
    schema.pre('aggregate', function (this: Aggregate<unknown>) {
      discharge(cls, this.pipeline());
    });
  };
