import {
  StreamingConstraintHandlerBundle,
  NO_RESOURCE_REPLACEMENT,
} from '../../lib/constraints/StreamingConstraintHandlerBundle';

function noop() {}
function noopConsumer(_v: any) {}
function noopSubscription(_s: any) {}
function noopRequest(_c: number) {}
function identity(v: any) { return v; }
function alwaysTrue(_v: any) { return true; }
function noopError(_e: Error) {}
function identityError(e: Error) { return e; }

function createBundle(overrides: Partial<{
  onDecision: () => void;
  onSubscribe: (subscription: any) => void;
  onRequest: (count: number) => void;
  replaceResource: any;
  filterPredicate: (element: any) => boolean;
  doOnNext: (value: any) => void;
  mapNext: (value: any) => any;
  doOnError: (error: Error) => void;
  mapError: (error: Error) => Error;
  onComplete: () => void;
  onCancel: () => void;
}> = {}): StreamingConstraintHandlerBundle {
  return new StreamingConstraintHandlerBundle(
    overrides.onDecision ?? noop,
    overrides.onSubscribe ?? noopSubscription,
    overrides.onRequest ?? noopRequest,
    overrides.replaceResource ?? NO_RESOURCE_REPLACEMENT,
    overrides.filterPredicate ?? alwaysTrue,
    overrides.doOnNext ?? noopConsumer,
    overrides.mapNext ?? identity,
    overrides.doOnError ?? noopError,
    overrides.mapError ?? identityError,
    overrides.onComplete ?? noop,
    overrides.onCancel ?? noop,
  );
}

describe('StreamingConstraintHandlerBundle', () => {
  describe('handleOnDecisionConstraints', () => {
    test('whenCalledThenRunsAllOnDecisionRunnables', () => {
      const calls: string[] = [];
      const bundle = createBundle({ onDecision: () => calls.push('ran') });

      bundle.handleOnDecisionConstraints();

      expect(calls).toEqual(['ran']);
    });

    test('whenNoRunnablesThenNoOp', () => {
      const bundle = createBundle();
      expect(() => bundle.handleOnDecisionConstraints()).not.toThrow();
    });
  });

  describe('handleOnSubscribeConstraints', () => {
    test('whenCalledThenRunsSubscriptionHandlers', () => {
      const captured: any[] = [];
      const bundle = createBundle({
        onSubscribe: (s) => captured.push(s),
      });

      bundle.handleOnSubscribeConstraints({ id: 'sub1' });

      expect(captured).toEqual([{ id: 'sub1' }]);
    });

    test('whenNoHandlersThenNoOp', () => {
      const bundle = createBundle();
      expect(() => bundle.handleOnSubscribeConstraints({})).not.toThrow();
    });
  });

  describe('handleOnRequestConstraints', () => {
    test('whenCalledThenRunsRequestHandlersWithCount', () => {
      const captured: number[] = [];
      const bundle = createBundle({
        onRequest: (c) => captured.push(c),
      });

      bundle.handleOnRequestConstraints(42);

      expect(captured).toEqual([42]);
    });

    test('whenNoHandlersThenNoOp', () => {
      const bundle = createBundle();
      expect(() => bundle.handleOnRequestConstraints(1)).not.toThrow();
    });
  });

  describe('handleAllOnNextConstraints', () => {
    test('whenNoReplaceResourceThenUsesOriginalValue', () => {
      const bundle = createBundle();
      expect(bundle.handleAllOnNextConstraints({ data: 'original' }))
        .toEqual({ data: 'original' });
    });

    test('whenReplaceResourcePresentThenReplacesValue', () => {
      const bundle = createBundle({ replaceResource: { data: 'replaced' } });
      expect(bundle.handleAllOnNextConstraints({ data: 'original' }))
        .toEqual({ data: 'replaced' });
    });

    test('whenArrayInputThenFilterAppliedPerElement', () => {
      const bundle = createBundle({
        filterPredicate: (el) => el.keep === true,
      });
      const result = bundle.handleAllOnNextConstraints([
        { keep: true, id: 1 },
        { keep: false, id: 2 },
        { keep: true, id: 3 },
      ]);
      expect(result).toEqual([
        { keep: true, id: 1 },
        { keep: true, id: 3 },
      ]);
    });

    test('whenSingleValueFailsFilterThenReturnsNull', () => {
      const bundle = createBundle({ filterPredicate: () => false });
      expect(bundle.handleAllOnNextConstraints({ id: 1 })).toBeNull();
    });

    test('whenDoOnNextThenSideEffectRuns', () => {
      const captured: any[] = [];
      const bundle = createBundle({ doOnNext: (v) => captured.push(v) });
      bundle.handleAllOnNextConstraints({ data: 'test' });
      expect(captured).toEqual([{ data: 'test' }]);
    });

    test('whenMapNextThenTransformsValue', () => {
      const bundle = createBundle({
        mapNext: (v) => ({ ...v, extra: true }),
      });
      expect(bundle.handleAllOnNextConstraints({ data: 'test' }))
        .toEqual({ data: 'test', extra: true });
    });

    test('whenNullInputThenFilterSkippedAndReturnsNull', () => {
      const filterCalled = { value: false };
      const bundle = createBundle({
        filterPredicate: () => { filterCalled.value = true; return true; },
      });
      const result = bundle.handleAllOnNextConstraints(null);
      expect(result).toBeNull();
      expect(filterCalled.value).toBe(false);
    });

    test('whenPipelineThenOrderIsReplaceFilterDoOnNextMapNext', () => {
      const order: string[] = [];
      const bundle = createBundle({
        replaceResource: [{ id: 1 }, { id: 2 }],
        filterPredicate: (el) => { order.push('filter'); return el.id === 1; },
        doOnNext: () => order.push('doOnNext'),
        mapNext: (v) => { order.push('mapNext'); return v; },
      });
      bundle.handleAllOnNextConstraints('original');
      expect(order).toEqual(['filter', 'filter', 'doOnNext', 'mapNext']);
    });
  });

  describe('handleAllOnErrorConstraints', () => {
    test('whenCalledThenDoOnErrorRunsBeforeMapError', () => {
      const order: string[] = [];
      const bundle = createBundle({
        doOnError: () => order.push('doOnError'),
        mapError: (e) => { order.push('mapError'); return e; },
      });
      bundle.handleAllOnErrorConstraints(new Error('test'));
      expect(order).toEqual(['doOnError', 'mapError']);
    });

    test('whenMapErrorTransformsThenReturnsTransformedError', () => {
      const bundle = createBundle({
        mapError: (e) => new Error(`wrapped: ${e.message}`),
      });
      expect(bundle.handleAllOnErrorConstraints(new Error('original')).message)
        .toBe('wrapped: original');
    });

    test('whenNoHandlersThenReturnsOriginalError', () => {
      const bundle = createBundle();
      const original = new Error('untouched');
      expect(bundle.handleAllOnErrorConstraints(original)).toBe(original);
    });
  });

  describe('handleOnCompleteConstraints', () => {
    test('whenCalledThenRunsAllOnCompleteRunnables', () => {
      const calls: string[] = [];
      const bundle = createBundle({ onComplete: () => calls.push('complete') });

      bundle.handleOnCompleteConstraints();

      expect(calls).toEqual(['complete']);
    });

    test('whenNoRunnablesThenNoOp', () => {
      const bundle = createBundle();
      expect(() => bundle.handleOnCompleteConstraints()).not.toThrow();
    });
  });

  describe('handleOnCancelConstraints', () => {
    test('whenCalledThenRunsAllOnCancelRunnables', () => {
      const calls: string[] = [];
      const bundle = createBundle({ onCancel: () => calls.push('cancel') });

      bundle.handleOnCancelConstraints();

      expect(calls).toEqual(['cancel']);
    });

    test('whenNoRunnablesThenNoOp', () => {
      const bundle = createBundle();
      expect(() => bundle.handleOnCancelConstraints()).not.toThrow();
    });
  });
});
