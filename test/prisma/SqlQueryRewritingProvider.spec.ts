import { SqlQueryRewritingProvider } from '../../lib/prisma/SqlQueryRewritingProvider';
import { rewriteSqlQuery } from '../../lib/prisma/SqlQueryRewriting';

const obligation = (extra: Record<string, unknown>) => ({ type: 'sql:queryRewriting', ...extra });

describe('rewriteSqlQuery', () => {
  describe('typed criteria operators', () => {
    it.each([
      ['=', { column: 'a', op: '=', value: 1 }, { a: 1 }],
      ['!=', { column: 'a', op: '!=', value: 1 }, { a: { not: 1 } }],
      ['>', { column: 'a', op: '>', value: 1 }, { a: { gt: 1 } }],
      ['>=', { column: 'a', op: '>=', value: 1 }, { a: { gte: 1 } }],
      ['<', { column: 'a', op: '<', value: 1 }, { a: { lt: 1 } }],
      ['<=', { column: 'a', op: '<=', value: 1 }, { a: { lte: 1 } }],
      ['in', { column: 'a', op: 'in', value: [1, 2] }, { a: { in: [1, 2] } }],
      ['isNull', { column: 'a', op: 'isNull' }, { a: null }],
      ['isNotNull', { column: 'a', op: 'isNotNull' }, { a: { not: null } }],
    ])('lowers %s into the expected Prisma where on empty args', (_op, criterion, expected) => {
      expect(rewriteSqlQuery(obligation({ criteria: [criterion] }), {}).where).toEqual(expected);
    });
  });

  it('lowers an or-group into OR', () => {
    const constraint = obligation({
      criteria: [
        {
          or: [
            { column: 'a', op: '=', value: 1 },
            { column: 'b', op: '=', value: 2 },
          ],
        },
      ],
    });
    expect(rewriteSqlQuery(constraint, {}).where).toEqual({ OR: [{ a: 1 }, { b: 2 }] });
  });

  it('AND-merges fragments with an existing where, original first', () => {
    const constraint = obligation({ criteria: [{ column: 'tenantId', op: '=', value: 7 }] });
    expect(rewriteSqlQuery(constraint, { where: { name: 'x' } }).where).toEqual({
      AND: [{ name: 'x' }, { tenantId: 7 }],
    });
  });

  it('preserves unrelated args while narrowing', () => {
    const constraint = obligation({ criteria: [{ column: 'tenantId', op: '=', value: 7 }] });
    const result = rewriteSqlQuery(constraint, { take: 10, orderBy: { id: 'asc' } });
    expect(result).toMatchObject({ take: 10, orderBy: { id: 'asc' }, where: { tenantId: 7 } });
  });

  describe('columns narrow the select', () => {
    it('sets select from columns when none present', () => {
      expect(rewriteSqlQuery(obligation({ columns: ['id', 'name'] }), {}).select).toEqual({
        id: true,
        name: true,
      });
    });

    it('intersects with an existing select (cannot add columns back)', () => {
      const result = rewriteSqlQuery(obligation({ columns: ['id', 'secret'] }), {
        select: { id: true, name: true },
      });
      expect(result.select).toEqual({ id: true });
    });
  });

  describe('fail-closed', () => {
    it('rejects raw SQL conditions', () => {
      expect(() => rewriteSqlQuery(obligation({ conditions: ['active = true'] }), {})).toThrow();
    });

    it('rejects an unsupported operator (like has no safe Prisma mapping)', () => {
      expect(() =>
        rewriteSqlQuery(obligation({ criteria: [{ column: 'a', op: 'like', value: '%x%' }] }), {}),
      ).toThrow();
    });

    it('rejects a criterion missing column or op', () => {
      expect(() => rewriteSqlQuery(obligation({ criteria: [{ column: 'a' }] }), {})).toThrow();
    });

    it('rejects non-array criteria', () => {
      expect(() =>
        rewriteSqlQuery(obligation({ criteria: { column: 'a', op: '=', value: 1 } }), {}),
      ).toThrow();
    });

    it('rejects non-string columns', () => {
      expect(() => rewriteSqlQuery(obligation({ columns: [1, 2] }), {})).toThrow();
    });
  });
});

describe('SqlQueryRewritingProvider', () => {
  const provider = new SqlQueryRewritingProvider();

  it.each(['sql:queryRewriting', 'relational:queryRewriting'])(
    'claims %s with a sql_query mapper',
    (type) => {
      const handlers = provider.getHandlers({ type, criteria: [{ column: 'a', op: '=', value: 1 }] });
      expect(handlers).toHaveLength(1);
      expect(handlers[0]).toMatchObject({ signal: 'sql_query', shape: 'mapper' });
      expect((handlers[0].handler({}) as { where: unknown }).where).toEqual({ a: 1 });
    },
  );

  it('does not claim other obligation types', () => {
    expect(provider.getHandlers({ type: 'filterJsonContent' })).toHaveLength(0);
    expect(provider.getHandlers(undefined)).toHaveLength(0);
  });
});
