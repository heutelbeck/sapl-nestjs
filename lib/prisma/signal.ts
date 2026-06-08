import type { SignalKind } from '../constraints/Signal';

/**
 * Signal kind a Prisma query-manipulation shim discharges at query time.
 * A `sql:queryRewriting` obligation attaches a mapper to this kind; the
 * shim feeds it the Prisma operation arguments and applies the narrowed
 * result.
 */
export const SQL_QUERY: SignalKind = 'sql_query';

/**
 * Reason carried by the {@link AccessDeniedError} when a sql_query
 * obligation handler fails (raises, or rejects arguments it cannot
 * narrow). Fail-closed: the query is denied rather than executed
 * unconstrained.
 */
export const SQL_QUERY_OBLIGATION_FAILURE = 'SQL_QUERY_OBLIGATION_FAILURE';

/**
 * Reason carried when a query-manipulation obligation is active but the
 * operation selects a single row by a unique key (findUnique, update,
 * delete, upsert). Such a selector cannot be AND-narrowed safely, so the
 * operation is denied; callers narrow with findFirst/updateMany/deleteMany.
 */
export const SQL_QUERY_UNNARROWABLE_OPERATION = 'SQL_QUERY_UNNARROWABLE_OPERATION';
