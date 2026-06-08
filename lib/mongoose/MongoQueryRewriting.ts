/**
 * Pure transform behind the `mongo:queryRewriting` obligation. Lowers a
 * typed-criteria + JSON-conditions obligation into a BSON filter and
 * AND-merges it with the application's filter so the obligation can only
 * narrow the result set, never widen it. Backend-compatible with the
 * Spring `MongoDbQueryRewritingProvider` and the Python `sapl_pymongo`
 * shim: condition strings are strict (double-quoted) JSON.
 */

/** Obligation `type` discriminator this transform claims. */
export const CONSTRAINT_TYPE = 'mongo:queryRewriting';

type Bson = Record<string, unknown>;

const leafToBson = (criterion: unknown): Bson => {
  const { column, op, value } = (criterion ?? {}) as { column?: unknown; op?: unknown; value?: unknown };
  if (typeof column !== 'string' || typeof op !== 'string') {
    throw new Error('mongo:queryRewriting criterion must have string column and op');
  }
  switch (op) {
    case '=':
      return { [column]: value };
    case '!=':
      return { [column]: { $ne: value } };
    case '>':
      return { [column]: { $gt: value } };
    case '>=':
      return { [column]: { $gte: value } };
    case '<':
      return { [column]: { $lt: value } };
    case '<=':
      return { [column]: { $lte: value } };
    case 'in':
      return { [column]: { $in: value } };
    case 'isNull':
      return { [column]: null };
    case 'isNotNull':
      return { [column]: { $ne: null } };
    default:
      throw new Error(`mongo:queryRewriting unsupported op: ${op}`);
  }
};

const criterionToBson = (criterion: unknown): Bson => {
  const group = criterion as { and?: unknown; or?: unknown };
  if (Array.isArray(group?.and)) return { $and: group.and.map(criterionToBson) };
  if (Array.isArray(group?.or)) return { $or: group.or.map(criterionToBson) };
  return leafToBson(criterion);
};

const parseConditions = (conditions: unknown): Bson[] => {
  if (conditions == null) return [];
  if (!Array.isArray(conditions)) throw new Error('mongo:queryRewriting conditions must be an array');
  return conditions.map((condition) => {
    if (typeof condition !== 'string')
      throw new Error('mongo:queryRewriting condition must be a JSON string');
    let parsed: unknown;
    try {
      parsed = JSON.parse(condition);
    } catch {
      throw new Error('mongo:queryRewriting condition is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('mongo:queryRewriting condition must be a JSON object');
    }
    return parsed as Bson;
  });
};

const isNonEmptyObject = (query: unknown): query is Bson =>
  query != null && typeof query === 'object' && !Array.isArray(query) && Object.keys(query).length > 0;

/**
 * Narrow `query` with the obligation's criteria and conditions. An
 * aggregation pipeline (array) cannot be narrowed by an AND-merge and is
 * rejected, surfacing fail-closed at the shim. Malformed criteria or
 * non-JSON conditions also throw.
 */
export const rewriteMongoQuery = (constraint: unknown, query: unknown): unknown => {
  if (Array.isArray(query)) {
    throw new Error('mongo:queryRewriting cannot narrow an aggregation pipeline');
  }
  const { criteria, conditions } = (constraint ?? {}) as { criteria?: unknown; conditions?: unknown };
  if (criteria != null && !Array.isArray(criteria)) {
    throw new Error('mongo:queryRewriting criteria must be an array');
  }
  const fragments: Bson[] = [
    ...((criteria as unknown[]) ?? []).map(criterionToBson),
    ...parseConditions(conditions),
  ];
  if (fragments.length === 0) return query;
  if (!isNonEmptyObject(query)) {
    return fragments.length === 1 ? fragments[0] : { $and: fragments };
  }
  return { $and: [query, ...fragments] };
};
