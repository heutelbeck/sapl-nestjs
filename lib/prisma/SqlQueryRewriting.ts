/**
 * Pure transform behind the `sql:queryRewriting` obligation for Prisma.
 * Lowers typed criteria into a Prisma `where` and AND-merges it with the
 * application's filter so the obligation can only narrow the result set,
 * never widen it. Optional `columns` narrow the `select`.
 *
 * Prisma's `where` is structured, not SQL, so the obligation's raw-SQL
 * `conditions` escape hatch cannot be lowered safely and is rejected
 * fail-closed; policies targeting Prisma use typed `criteria`.
 */

/** Obligation `type` discriminators this transform claims. */
export const CONSTRAINT_TYPE_SQL = 'sql:queryRewriting';
export const CONSTRAINT_TYPE_RELATIONAL = 'relational:queryRewriting';

type Where = Record<string, unknown>;
type OperationArgs = Record<string, unknown>;

const leafToWhere = (criterion: unknown): Where => {
  const { column, op, value } = (criterion ?? {}) as { column?: unknown; op?: unknown; value?: unknown };
  if (typeof column !== 'string' || typeof op !== 'string') {
    throw new Error('sql:queryRewriting criterion must have string column and op');
  }
  switch (op) {
    case '=':
      return { [column]: value };
    case '!=':
      return { [column]: { not: value } };
    case '>':
      return { [column]: { gt: value } };
    case '>=':
      return { [column]: { gte: value } };
    case '<':
      return { [column]: { lt: value } };
    case '<=':
      return { [column]: { lte: value } };
    case 'in':
      return { [column]: { in: value } };
    case 'isNull':
      return { [column]: null };
    case 'isNotNull':
      return { [column]: { not: null } };
    default:
      // like/notLike and any other op have no safe structured Prisma mapping.
      throw new Error(`sql:queryRewriting unsupported op: ${op}`);
  }
};

const criterionToWhere = (criterion: unknown): Where => {
  const group = criterion as { and?: unknown; or?: unknown };
  if (Array.isArray(group?.and)) return { AND: group.and.map(criterionToWhere) };
  if (Array.isArray(group?.or)) return { OR: group.or.map(criterionToWhere) };
  return leafToWhere(criterion);
};

const isNonEmptyObject = (value: unknown): value is Where =>
  value != null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

const mergeWhere = (existing: unknown, fragments: Where[]): unknown => {
  if (fragments.length === 0) return existing;
  if (!isNonEmptyObject(existing)) {
    return fragments.length === 1 ? fragments[0] : { AND: fragments };
  }
  return { AND: [existing, ...fragments] };
};

const narrowSelect = (existing: unknown, columns: string[]): Where => {
  if (!isNonEmptyObject(existing)) {
    return Object.fromEntries(columns.map((column) => [column, true]));
  }
  // Intersect with the caller's projection: the obligation can only remove
  // columns, never add them back.
  const intersection: Where = {};
  for (const column of columns) {
    if (existing[column]) intersection[column] = true;
  }
  return intersection;
};

const rejectRawConditions = (conditions: unknown): void => {
  if (conditions == null) return;
  if (!Array.isArray(conditions)) throw new Error('sql:queryRewriting conditions must be an array');
  if (conditions.length > 0) {
    throw new Error(
      'sql:queryRewriting raw conditions are not supported by the Prisma shim; use typed criteria',
    );
  }
};

/**
 * Narrow Prisma operation `args` with the obligation's criteria and
 * columns. Malformed criteria, unsupported ops, or raw-SQL conditions
 * throw, surfacing fail-closed at the shim.
 */
export const rewriteSqlQuery = (constraint: unknown, args: unknown): OperationArgs => {
  const { criteria, conditions, columns } = (constraint ?? {}) as {
    criteria?: unknown;
    conditions?: unknown;
    columns?: unknown;
  };
  rejectRawConditions(conditions);
  if (criteria != null && !Array.isArray(criteria)) {
    throw new Error('sql:queryRewriting criteria must be an array');
  }
  const fragments = ((criteria as unknown[]) ?? []).map(criterionToWhere);
  const next: OperationArgs = { ...((args as OperationArgs) ?? {}) };
  next.where = mergeWhere(next.where, fragments);
  if (columns != null) {
    if (!Array.isArray(columns) || columns.some((column) => typeof column !== 'string')) {
      throw new Error('sql:queryRewriting columns must be an array of strings');
    }
    next.select = narrowSelect(next.select, columns as string[]);
  }
  return next;
};
