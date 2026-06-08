import { MongoDbQueryRewritingProvider } from '../../lib/mongoose/MongoDbQueryRewritingProvider';
import { rewriteMongoQuery } from '../../lib/mongoose/MongoQueryRewriting';

const obligation = (extra: Record<string, unknown>) => ({ type: 'mongo:queryRewriting', ...extra });

describe('rewriteMongoQuery', () => {
  describe('typed criteria operators', () => {
    it.each([
      ['=', { column: 'a', op: '=', value: 1 }, { a: 1 }],
      ['!=', { column: 'a', op: '!=', value: 1 }, { a: { $ne: 1 } }],
      ['>', { column: 'a', op: '>', value: 1 }, { a: { $gt: 1 } }],
      ['>=', { column: 'a', op: '>=', value: 1 }, { a: { $gte: 1 } }],
      ['<', { column: 'a', op: '<', value: 1 }, { a: { $lt: 1 } }],
      ['<=', { column: 'a', op: '<=', value: 1 }, { a: { $lte: 1 } }],
      ['in', { column: 'a', op: 'in', value: [1, 2] }, { a: { $in: [1, 2] } }],
      ['isNull', { column: 'a', op: 'isNull' }, { a: null }],
      ['isNotNull', { column: 'a', op: 'isNotNull' }, { a: { $ne: null } }],
    ])('lowers %s into the expected fragment on an empty query', (_op, criterion, expected) => {
      expect(rewriteMongoQuery(obligation({ criteria: [criterion] }), {})).toEqual(expected);
    });
  });

  it('lowers an or-group', () => {
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
    expect(rewriteMongoQuery(constraint, {})).toEqual({ $or: [{ a: 1 }, { b: 2 }] });
  });

  it('lowers an and-group', () => {
    const constraint = obligation({
      criteria: [
        {
          and: [
            { column: 'a', op: '=', value: 1 },
            { column: 'b', op: '=', value: 2 },
          ],
        },
      ],
    });
    expect(rewriteMongoQuery(constraint, {})).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
  });

  it('AND-merges fragments with a non-empty application filter, original first', () => {
    const constraint = obligation({ criteria: [{ column: 'tenantId', op: '=', value: 7 }] });
    expect(rewriteMongoQuery(constraint, { name: 'x' })).toEqual({
      $and: [{ name: 'x' }, { tenantId: 7 }],
    });
  });

  it('wraps multiple fragments in $and even on an empty query', () => {
    const constraint = obligation({
      criteria: [
        { column: 'a', op: '=', value: 1 },
        { column: 'b', op: '=', value: 2 },
      ],
    });
    expect(rewriteMongoQuery(constraint, {})).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
  });

  it('parses a double-quoted JSON condition and merges it', () => {
    const constraint = obligation({ conditions: ['{"age": {"$gte": 18}}'] });
    expect(rewriteMongoQuery(constraint, { name: 'x' })).toEqual({
      $and: [{ name: 'x' }, { age: { $gte: 18 } }],
    });
  });

  it('returns the query unchanged when the obligation carries no fragments', () => {
    expect(rewriteMongoQuery(obligation({}), { name: 'x' })).toEqual({ name: 'x' });
  });

  describe('fail-closed', () => {
    it('rejects a single-quoted (non-JSON) condition', () => {
      const constraint = obligation({ conditions: ["{'age': 18}"] });
      expect(() => rewriteMongoQuery(constraint, {})).toThrow();
    });

    it('rejects a condition that is not a JSON object', () => {
      expect(() => rewriteMongoQuery(obligation({ conditions: ['42'] }), {})).toThrow();
    });

    it('rejects an aggregation pipeline', () => {
      expect(() =>
        rewriteMongoQuery(obligation({ criteria: [{ column: 'a', op: '=', value: 1 }] }), [{ $match: {} }]),
      ).toThrow();
    });

    it('rejects a criterion missing column or op', () => {
      expect(() => rewriteMongoQuery(obligation({ criteria: [{ column: 'a' }] }), {})).toThrow();
    });

    it('rejects an unsupported operator', () => {
      expect(() =>
        rewriteMongoQuery(obligation({ criteria: [{ column: 'a', op: '~=', value: 1 }] }), {}),
      ).toThrow();
    });

    it('rejects non-array criteria', () => {
      expect(() =>
        rewriteMongoQuery(obligation({ criteria: { column: 'a', op: '=', value: 1 } }), {}),
      ).toThrow();
    });
  });
});

describe('MongoDbQueryRewritingProvider', () => {
  const provider = new MongoDbQueryRewritingProvider();

  it('claims the mongo:queryRewriting obligation with a mongo_query mapper', () => {
    const handlers = provider.getHandlers(obligation({ criteria: [{ column: 'a', op: '=', value: 1 }] }));
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({ signal: 'mongo_query', shape: 'mapper' });
    expect(handlers[0].handler({})).toEqual({ a: 1 });
  });

  it('does not claim other obligation types', () => {
    expect(provider.getHandlers({ type: 'filterJsonContent' })).toHaveLength(0);
    expect(provider.getHandlers(undefined)).toHaveLength(0);
  });
});
