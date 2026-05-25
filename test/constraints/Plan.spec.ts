import { EnforcementPlan, PlanEntry, absent, present } from '../../lib/constraints/Plan';
import type { Signal, SignalKind } from '../../lib/constraints/Signal';
import type { AuthorizationDecision } from '../../lib/types';

const PERMIT: AuthorizationDecision = { decision: 'PERMIT' };

const entry = (overrides: Partial<PlanEntry> & Pick<PlanEntry, 'handler'>): PlanEntry => ({
  signal: 'output',
  priority: 0,
  shape: 'mapper',
  tag: 'obligation',
  constraint: { type: 'test' },
  ...overrides,
});

const planOf = (entries: Record<SignalKind, PlanEntry[]> | Partial<Record<SignalKind, PlanEntry[]>>) =>
  new EnforcementPlan(new Map(Object.entries(entries) as [SignalKind, PlanEntry[]][]));

describe('EnforcementPlan.execute', () => {
  test('whenNoEntriesForSignalThenReturnsOriginalValueAndPriorFailure', () => {
    const plan = planOf({});
    const result = plan.execute({ kind: 'output', value: 42 }, true);

    expect(result.value).toEqual(present(42));
    expect(result.failureState).toBe(true);
  });

  test('whenMapperEntryThenThreadsTransformedValueThroughChain', () => {
    const plan = planOf({
      output: [
        entry({ shape: 'mapper', handler: (v) => (v as number) + 1 }),
        entry({ shape: 'mapper', priority: 1, handler: (v) => (v as number) * 10 }),
      ],
    });
    const result = plan.execute({ kind: 'output', value: 5 });

    expect(result.value).toEqual(present(60));
    expect(result.failureState).toBe(false);
  });

  test('whenConsumerObservesValueThenValueIsUnchanged', () => {
    const observed: unknown[] = [];
    const plan = planOf({
      output: [entry({ shape: 'consumer', handler: (v) => observed.push(v) })],
    });
    const result = plan.execute({ kind: 'output', value: 'item' });

    expect(observed).toEqual(['item']);
    expect(result.value).toEqual(present('item'));
  });

  test('whenRunnerEntryThenSideEffectFiresAndValueIsUnchanged', () => {
    let invoked = 0;
    const plan = planOf({
      output: [
        entry({
          shape: 'runner',
          handler: () => {
            invoked += 1;
          },
        }),
      ],
    });
    const result = plan.execute({ kind: 'output', value: 'x' });

    expect(invoked).toBe(1);
    expect(result.value).toEqual(present('x'));
  });

  test('whenVoidSignalThenRunnerFiresAndMapperConsumerAreSkipped', () => {
    let runnerCalled = 0;
    let mapperCalled = 0;
    let consumerCalled = 0;
    const plan = planOf({
      complete: [
        entry({
          signal: 'complete',
          shape: 'runner',
          handler: () => {
            runnerCalled += 1;
          },
        }),
        entry({
          signal: 'complete',
          shape: 'mapper',
          handler: () => {
            mapperCalled += 1;
            return 'x';
          },
        }),
        entry({
          signal: 'complete',
          shape: 'consumer',
          handler: () => {
            consumerCalled += 1;
          },
        }),
      ],
    });
    const result = plan.execute({ kind: 'complete' });

    expect(runnerCalled).toBe(1);
    expect(mapperCalled).toBe(0);
    expect(consumerCalled).toBe(0);
    expect(result.value).toEqual(absent);
  });

  test('whenObligationHandlerThrowsThenFailureStateIsSetAndExecutionContinues', () => {
    let second = 0;
    const plan = planOf({
      output: [
        entry({
          tag: 'obligation',
          shape: 'consumer',
          handler: () => {
            throw new Error('boom');
          },
        }),
        entry({
          tag: 'obligation',
          shape: 'consumer',
          priority: 1,
          handler: () => {
            second += 1;
          },
        }),
      ],
    });
    const result = plan.execute({ kind: 'output', value: 'v' });

    expect(result.failureState).toBe(true);
    expect(second).toBe(1);
  });

  test('whenAdviceHandlerThrowsThenFailureStateUnchangedAndExecutionContinues', () => {
    let second = 0;
    const plan = planOf({
      output: [
        entry({
          tag: 'advice',
          shape: 'consumer',
          handler: () => {
            throw new Error('boom');
          },
        }),
        entry({
          tag: 'advice',
          shape: 'consumer',
          priority: 1,
          handler: () => {
            second += 1;
          },
        }),
      ],
    });
    const result = plan.execute({ kind: 'output', value: 'v' });

    expect(result.failureState).toBe(false);
    expect(second).toBe(1);
  });

  test('whenPriorFailureTrueThenPropagatesIntoResult', () => {
    const plan = planOf({});
    const result = plan.execute({ kind: 'output', value: 'v' }, true);

    expect(result.failureState).toBe(true);
  });

  test('whenMapperReturnsUndefinedThenValueIsPassedThrough', () => {
    const plan = planOf({
      output: [entry({ shape: 'mapper', handler: () => undefined })],
    });
    const result = plan.execute({ kind: 'output', value: 'kept' });

    expect(result.value).toEqual(present('kept'));
  });

  test.each<[SignalKind, Signal]>([
    ['decision', { kind: 'decision', value: PERMIT }],
    ['input', { kind: 'input', value: [1, 2] }],
    ['output', { kind: 'output', value: 'x' }],
    ['error', { kind: 'error', value: new Error('e') }],
    ['subscribe', { kind: 'subscribe' }],
    ['cancel', { kind: 'cancel' }],
    ['complete', { kind: 'complete' }],
    ['termination', { kind: 'termination' }],
  ])('whenAllEightSignalKindsDispatchedThenRunnerFiresFor=%s', (kind, signal) => {
    let invoked = 0;
    const plan = planOf({
      [kind]: [
        entry({
          signal: kind,
          shape: 'runner',
          handler: () => {
            invoked += 1;
          },
        }),
      ],
    });
    plan.execute(signal);

    expect(invoked).toBe(1);
  });
});
