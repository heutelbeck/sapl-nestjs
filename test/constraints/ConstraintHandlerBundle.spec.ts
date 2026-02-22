import { ConstraintHandlerBundle, NO_RESOURCE_REPLACEMENT } from '../../lib/constraints/ConstraintHandlerBundle';
import { SubscriptionContext } from '../../lib/SubscriptionContext';
import { createCtx } from '../test-helpers';

function noop() {}
function noopConsumer(_v: any) {}
function identity(v: any) { return v; }
function alwaysTrue(_v: any) { return true; }
function noopError(_e: Error) {}
function identityError(e: Error) { return e; }
function noopCtx(_ctx: SubscriptionContext) {}

function createBundle(overrides: Partial<{
  onDecision: () => void;
  methodInvocation: (ctx: SubscriptionContext) => void;
  replaceResource: any | null;
  filterPredicate: (element: any) => boolean;
  doOnNext: (value: any) => void;
  mapNext: (value: any) => any;
  doOnError: (error: Error) => void;
  mapError: (error: Error) => Error;
}> = {}): ConstraintHandlerBundle {
  return new ConstraintHandlerBundle(
    overrides.onDecision ?? noop,
    overrides.methodInvocation ?? noopCtx,
    overrides.replaceResource ?? NO_RESOURCE_REPLACEMENT,
    overrides.filterPredicate ?? alwaysTrue,
    overrides.doOnNext ?? noopConsumer,
    overrides.mapNext ?? identity,
    overrides.doOnError ?? noopError,
    overrides.mapError ?? identityError,
  );
}

describe('ConstraintHandlerBundle', () => {
  describe('handleOnDecisionConstraints', () => {
    test('whenCalledThenRunsAllRunnables', () => {
      const calls: string[] = [];
      const bundle = createBundle({
        onDecision: () => calls.push('ran'),
      });

      bundle.handleOnDecisionConstraints();

      expect(calls).toEqual(['ran']);
    });

    test('whenNoRunnablesThenNoOp', () => {
      const bundle = createBundle();
      expect(() => bundle.handleOnDecisionConstraints()).not.toThrow();
    });
  });

  describe('handleMethodInvocationHandlers', () => {
    test('whenCalledThenReceivesContext', () => {
      const captured: SubscriptionContext[] = [];
      const bundle = createBundle({
        methodInvocation: (ctx) => captured.push(ctx),
      });
      const ctx = createCtx({ handler: 'myHandler' });

      bundle.handleMethodInvocationHandlers(ctx);

      expect(captured).toHaveLength(1);
      expect(captured[0].handler).toBe('myHandler');
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

    test('whenUndefinedInputThenFilterCalledAndReturnsNull', () => {
      const bundle = createBundle({ filterPredicate: () => false });
      expect(bundle.handleAllOnNextConstraints(undefined)).toBeNull();
    });

    test('whenUndefinedInputAndFilterPassesThenDoOnNextAndMapNextRun', () => {
      const captured: any[] = [];
      const bundle = createBundle({
        doOnNext: (v) => captured.push(v),
        mapNext: (v) => v ?? 'mapped-from-undefined',
      });
      const result = bundle.handleAllOnNextConstraints(undefined);
      expect(captured).toEqual([undefined]);
      expect(result).toBe('mapped-from-undefined');
    });

    test('whenReplaceResourceAndFilterThenReplaceAppliedFirst', () => {
      const bundle = createBundle({
        replaceResource: [{ keep: true }, { keep: false }],
        filterPredicate: (el) => el.keep,
      });
      expect(bundle.handleAllOnNextConstraints('ignored'))
        .toEqual([{ keep: true }]);
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

    test('whenEmptyArrayAfterFilterThenDoOnNextReceivesEmptyArray', () => {
      const captured: any[] = [];
      const bundle = createBundle({
        filterPredicate: () => false,
        doOnNext: (v) => captured.push(v),
      });
      bundle.handleAllOnNextConstraints([{ id: 1 }, { id: 2 }]);
      expect(captured).toEqual([[]]);
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
});
