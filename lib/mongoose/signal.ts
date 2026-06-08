import type { SignalKind } from '../constraints/Signal';

/**
 * Signal kind a Mongoose query-manipulation shim discharges at query
 * time. A `mongo:queryRewriting` obligation attaches a mapper to this
 * kind; the shim feeds it the query filter and applies the narrowed
 * result.
 */
export const MONGO_QUERY: SignalKind = 'mongo_query';

/**
 * Reason carried by the {@link AccessDeniedError} when a mongo_query
 * obligation handler fails (raises, or rejects a query it cannot
 * narrow such as an aggregation pipeline). Fail-closed: the query is
 * denied rather than executed unconstrained.
 */
export const MONGO_QUERY_OBLIGATION_FAILURE = 'MONGO_QUERY_OBLIGATION_FAILURE';
