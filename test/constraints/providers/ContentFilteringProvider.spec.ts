import { ContentFilteringProvider } from '../../../lib/constraints/providers/ContentFilteringProvider';

describe('ContentFilteringProvider', () => {
  const provider = new ContentFilteringProvider();

  describe('isResponsible', () => {
    test('whenTypeIsFilterJsonContentThenReturnsTrue', () => {
      expect(provider.isResponsible({ type: 'filterJsonContent' })).toBe(true);
    });

    test.each([
      { type: 'other' },
      { type: 'jsonContentFilterPredicate' },
      {},
      null,
      undefined,
    ])('whenTypeIs%pThenReturnsFalse', (constraint) => {
      expect(provider.isResponsible(constraint)).toBe(false);
    });
  });

  test('whenGetPriorityThenReturnsZero', () => {
    expect(provider.getPriority()).toBe(0);
  });

  test('whenGetHandlerThenDelegatesToContentFilter', () => {
    const handler = provider.getHandler({
      actions: [{ type: 'delete', path: '$.ssn' }],
    });
    const result = handler({ name: 'Jane', ssn: '123' });
    expect(result).toEqual({ name: 'Jane' });
  });
});
