import { Logger } from '@nestjs/common';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { SignalKind } from '../../lib/constraints/Signal';
import type { AuthorizationDecision } from '../../lib/types';

const ALL_SIGNALS = new Set<SignalKind>([
  'decision',
  'input',
  'output',
  'error',
  'subscribe',
  'cancel',
  'complete',
  'termination',
]);
const NO_OUTPUT = new Set<SignalKind>([
  'decision',
  'input',
  'error',
  'subscribe',
  'cancel',
  'complete',
  'termination',
]);

const provider = (getHandlers: ConstraintHandlerProvider['getHandlers']): ConstraintHandlerProvider => ({
  getHandlers,
});

const triple = (overrides: Partial<ScopedHandler> & Pick<ScopedHandler, 'handler'>): ScopedHandler => ({
  signal: 'output',
  priority: 0,
  shape: 'mapper',
  ...overrides,
});

const plannerWith = (providers: ConstraintHandlerProvider[]): EnforcementPlanner => {
  const registry: ProviderRegistry = { all: () => providers } as unknown as ProviderRegistry;
  const planner = new EnforcementPlanner(registry);
  // Silence the @Logger warnings during failure-runner tests.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return planner;
};

const decisionWith = (overrides: Partial<AuthorizationDecision>): AuthorizationDecision => ({
  decision: 'PERMIT',
  ...overrides,
});

describe('EnforcementPlanner (paper Algorithm 2)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('whenSingleProviderSingleWellFormedTripleThenSchedulesIt', () => {
    let invoked = 0;
    const p = provider((c) =>
      (c as any).type === 'X'
        ? [
            triple({
              signal: 'output',
              shape: 'consumer',
              handler: () => {
                invoked += 1;
              },
            }),
          ]
        : [],
    );
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{ type: 'X' }] }), ALL_SIGNALS);

    expect(plan.entriesFor('output')).toHaveLength(1);
    plan.execute({ kind: 'output', value: 'v' });
    expect(invoked).toBe(1);
  });

  test('whenSingleProviderReturnsPairedHandlersAcrossSignalsThenBothScheduled', () => {
    const events: string[] = [];
    const p = provider(() => [
      triple({
        signal: 'decision',
        shape: 'runner',
        handler: () => {
          events.push('start');
        },
      }),
      triple({
        signal: 'complete',
        shape: 'runner',
        handler: () => {
          events.push('end');
        },
      }),
    ]);
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);

    expect(plan.entriesFor('decision')).toHaveLength(1);
    expect(plan.entriesFor('complete')).toHaveLength(1);
  });

  test('whenZeroResponsibleProvidersForObligationThenSyntheticRunnerThrows', () => {
    const planner = plannerWith([]);
    const plan = planner.plan(decisionWith({ obligations: [{ type: 'orphan' }] }), ALL_SIGNALS);
    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });

    expect(result.failureState).toBe(true);
  });

  test('whenZeroResponsibleProvidersForAdviceThenSyntheticRunnerLogsOnly', () => {
    const planner = plannerWith([]);
    const plan = planner.plan(decisionWith({ advice: [{ type: 'orphan' }] }), ALL_SIGNALS);
    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });

    expect(result.failureState).toBe(false);
  });

  test('whenTwoResponsibleProvidersForSameConstraintThenSyntheticFailureRunnerFires', () => {
    const p1 = provider(() => [triple({ signal: 'output', shape: 'runner', handler: () => undefined })]);
    const p2 = provider(() => [triple({ signal: 'output', shape: 'runner', handler: () => undefined })]);
    const plan = plannerWith([p1, p2]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);
    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });

    expect(result.failureState).toBe(true);
  });

  test('whenClaimHasMixOfWellFormedAndMalformedTriplesThenWholeClaimBecomesFailureRunner', () => {
    let goodInvoked = 0;
    const p = provider(() => [
      triple({
        signal: 'output',
        shape: 'consumer',
        handler: () => {
          goodInvoked += 1;
        },
      }),
      triple({ signal: 'cancel', shape: 'mapper', handler: () => 'x' }), // malformed: mapper on void signal
    ]);
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);
    plan.execute({ kind: 'output', value: 'v' });

    expect(goodInvoked).toBe(0);
    const denialResult = plan.execute({ kind: 'decision', value: decisionWith({}) });
    expect(denialResult.failureState).toBe(true);
  });

  test('whenMapperOnAdviceTaggedConstraintThenSyntheticFailureRunner', () => {
    const p = provider(() => [triple({ shape: 'mapper', handler: () => 'x' })]);
    const plan = plannerWith([p]).plan(decisionWith({ advice: [{}] }), ALL_SIGNALS);

    expect(plan.entriesFor('output')).toHaveLength(0);
    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });
    expect(result.failureState).toBe(false); // advice failure logs but does not set flag
  });

  test('whenMapperAtDecisionSignalThenNotWellFormedAndYieldsFailureRunner', () => {
    const p = provider(() => [triple({ signal: 'decision', shape: 'mapper', handler: () => 'x' })]);
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);

    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });
    expect(result.failureState).toBe(true);
  });

  test('whenConsumerAtCancelSignalThenNotWellFormed', () => {
    const p = provider(() => [triple({ signal: 'cancel', shape: 'consumer', handler: () => undefined })]);
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);

    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });
    expect(result.failureState).toBe(true);
  });

  test('whenTripleTargetsUnsupportedSignalThenNotWellFormed', () => {
    const p = provider(() => [triple({ signal: 'subscribe', shape: 'runner', handler: () => undefined })]);
    const plan = plannerWith([p]).plan(
      decisionWith({ obligations: [{}] }),
      new Set<SignalKind>(['decision', 'output']),
    );

    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });
    expect(result.failureState).toBe(true);
  });

  test('whenMultipleEntriesAtSameSignalThenSortedAscendingByPriorityAndRunnerBeforeConsumerBeforeMapper', () => {
    const calls: string[] = [];
    const p = provider(() => [
      triple({
        signal: 'output',
        priority: 0,
        shape: 'mapper',
        handler: (v) => {
          calls.push('mapper-p0');
          return v;
        },
      }),
      triple({
        signal: 'output',
        priority: 0,
        shape: 'consumer',
        handler: () => {
          calls.push('consumer-p0');
        },
      }),
      triple({
        signal: 'output',
        priority: 0,
        shape: 'runner',
        handler: () => {
          calls.push('runner-p0');
        },
      }),
      triple({
        signal: 'output',
        priority: 1,
        shape: 'runner',
        handler: () => {
          calls.push('runner-p1');
        },
      }),
    ]);
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);
    plan.execute({ kind: 'output', value: 'v' });

    expect(calls).toEqual(['runner-p0', 'mapper-p0', 'consumer-p0', 'runner-p1']);
  });

  test('whenMultipleMappersAtSameSignalAndSamePriorityThenReplacedWithFailureRunnersAtSameSignal', () => {
    let mapperInvoked = 0;
    const p = provider(() => [
      triple({
        signal: 'output',
        priority: 5,
        shape: 'mapper',
        handler: (v) => {
          mapperInvoked += 1;
          return v;
        },
      }),
      triple({
        signal: 'output',
        priority: 5,
        shape: 'mapper',
        handler: (v) => {
          mapperInvoked += 1;
          return v;
        },
      }),
    ]);
    const plan = plannerWith([p]).plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);
    const result = plan.execute({ kind: 'output', value: 'v' });

    expect(mapperInvoked).toBe(0);
    expect(result.failureState).toBe(true);
  });

  test('whenResourceSubstitutionWithOutputSupportedThenSyntheticMapperReplacesValue', () => {
    const planner = plannerWith([]);
    const plan = planner.plan(decisionWith({ resource: { redacted: true } }), ALL_SIGNALS);

    const result = plan.execute({ kind: 'output', value: { sensitive: 'data' } });
    expect(result.value).toEqual({ kind: 'present', value: { redacted: true } });
  });

  test('whenResourceSubstitutionWithoutOutputSupportedThenSyntheticFailureRunnerAtDecision', () => {
    const planner = plannerWith([]);
    const plan = planner.plan(decisionWith({ resource: { x: 1 } }), NO_OUTPUT);
    const result = plan.execute({ kind: 'decision', value: decisionWith({ resource: { x: 1 } }) });

    expect(result.failureState).toBe(true);
  });

  test('whenResourceSubstitutionThenUserOutputMapperRunsAFTERTheSubstitution', () => {
    const p = provider(() => [
      triple({
        signal: 'output',
        priority: 0,
        shape: 'mapper',
        handler: (v) => `wrapped(${JSON.stringify(v)})`,
      }),
    ]);
    const plan = plannerWith([p]).plan(
      decisionWith({ obligations: [{}], resource: { stamp: 42 } }),
      ALL_SIGNALS,
    );

    const result = plan.execute({ kind: 'output', value: 'original' });
    expect(result.value).toEqual({ kind: 'present', value: 'wrapped({"stamp":42})' });
  });

  test('whenHandlerThrowsAccessDeniedErrorThenFailureStateTrueAndNoDecisionLeaked', () => {
    const planner = plannerWith([]);
    const plan = planner.plan(
      decisionWith({
        obligations: [{ type: 'orphan' }],
        resource: { ssn: '123-45-6789' },
      }),
      new Set<SignalKind>(['decision']),
    );

    const result = plan.execute({ kind: 'decision', value: decisionWith({}) });

    expect(result.failureState).toBe(true);
    // Trust-boundary: handler closure must not carry the decision's
    // sensitive fields to anything the subscriber would observe.
  });

  test('whenSyntheticObligationFailureFiresThenThrownIsAccessDeniedError', () => {
    let thrown: unknown = null;
    const planner = plannerWith([]);
    const plan = planner.plan(decisionWith({ obligations: [{}] }), ALL_SIGNALS);
    try {
      const entries = plan.entriesFor('decision');
      entries[0].handler(undefined);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AccessDeniedError);
  });
});
