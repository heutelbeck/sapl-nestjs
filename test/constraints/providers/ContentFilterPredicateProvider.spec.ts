import { ContentFilterPredicateProvider } from '../../../lib/constraints/providers/ContentFilterPredicateProvider';

describe('ContentFilterPredicateProvider', () => {
  const provider = new ContentFilterPredicateProvider();

  test('whenConstraintIsNotJsonContentFilterPredicateThenReturnsEmptyHandlers', () => {
    expect(provider.getHandlers({ type: 'filterJsonContent' })).toEqual([]);
    expect(provider.getHandlers({ type: 'other' })).toEqual([]);
    expect(provider.getHandlers({})).toEqual([]);
    expect(provider.getHandlers(null)).toEqual([]);
    expect(provider.getHandlers(undefined)).toEqual([]);
  });

  test('whenConstraintMatchesThenReturnsOutputMapperAtPriorityZero', () => {
    const handlers = provider.getHandlers({
      type: 'jsonContentFilterPredicate',
      conditions: [{ path: '$.status', type: '==', value: 'active' }],
    });

    expect(handlers).toHaveLength(1);
    const [h] = handlers;
    expect(h.signal).toBe('output');
    expect(h.shape).toBe('mapper');
    expect(h.priority).toBe(0);
  });

  test('whenHandlerInvokedOnArrayThenFiltersElementsByPredicate', () => {
    const [h] = provider.getHandlers({
      type: 'jsonContentFilterPredicate',
      conditions: [{ path: '$.status', type: '==', value: 'active' }],
    });

    const result = h.handler([{ status: 'active' }, { status: 'inactive' }, { status: 'active' }]);
    expect(result).toEqual([{ status: 'active' }, { status: 'active' }]);
  });

  test('whenHandlerInvokedOnNonMatchingSingletonThenReturnsNull', () => {
    const [h] = provider.getHandlers({
      type: 'jsonContentFilterPredicate',
      conditions: [{ path: '$.status', type: '==', value: 'active' }],
    });

    expect(h.handler({ status: 'inactive' })).toBeNull();
  });

  test('whenHandlerInvokedOnMatchingSingletonThenReturnsValueUnchanged', () => {
    const [h] = provider.getHandlers({
      type: 'jsonContentFilterPredicate',
      conditions: [{ path: '$.status', type: '==', value: 'active' }],
    });

    const value = { status: 'active' };
    expect(h.handler(value)).toBe(value);
  });
});
