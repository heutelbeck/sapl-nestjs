import { ContentFilterPredicateProvider } from '../../../lib/constraints/providers/ContentFilterPredicateProvider';

describe('ContentFilterPredicateProvider', () => {
  const provider = new ContentFilterPredicateProvider();

  describe('isResponsible', () => {
    test('whenTypeIsJsonContentFilterPredicateThenReturnsTrue', () => {
      expect(provider.isResponsible({ type: 'jsonContentFilterPredicate' })).toBe(true);
    });

    test.each([
      { type: 'filterJsonContent' },
      { type: 'other' },
      {},
      null,
      undefined,
    ])('whenTypeIs%pThenReturnsFalse', (constraint) => {
      expect(provider.isResponsible(constraint)).toBe(false);
    });
  });

  test('whenGetHandlerThenDelegatesToContentFilterPredicateFromConditions', () => {
    const handler = provider.getHandler({
      conditions: [{ path: '$.status', type: '==', value: 'active' }],
    });
    expect(handler({ status: 'active' })).toBe(true);
    expect(handler({ status: 'inactive' })).toBe(false);
  });
});
