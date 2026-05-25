import { ContentFilteringProvider } from '../../../lib/constraints/providers/ContentFilteringProvider';

describe('ContentFilteringProvider', () => {
  const provider = new ContentFilteringProvider();

  test('whenConstraintIsNotFilterJsonContentThenReturnsEmptyHandlers', () => {
    expect(provider.getHandlers({ type: 'other' })).toEqual([]);
    expect(provider.getHandlers({ type: 'jsonContentFilterPredicate' })).toEqual([]);
    expect(provider.getHandlers({})).toEqual([]);
    expect(provider.getHandlers(null)).toEqual([]);
    expect(provider.getHandlers(undefined)).toEqual([]);
  });

  test('whenConstraintMatchesThenReturnsOutputMapperAtPriorityZero', () => {
    const handlers = provider.getHandlers({
      type: 'filterJsonContent',
      actions: [{ type: 'delete', path: '$.ssn' }],
    });

    expect(handlers).toHaveLength(1);
    const [h] = handlers;
    expect(h.signal).toBe('output');
    expect(h.shape).toBe('mapper');
    expect(h.priority).toBe(0);
  });

  test('whenHandlerInvokedThenAppliesContentFilterTransformation', () => {
    const [h] = provider.getHandlers({
      type: 'filterJsonContent',
      actions: [{ type: 'delete', path: '$.ssn' }],
    });
    const result = h.handler({ name: 'Jane', ssn: '123' });

    expect(result).toEqual({ name: 'Jane' });
  });
});
