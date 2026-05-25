import { Observable, Subject, Subscription } from 'rxjs';
import type { AuthorizationDecision, Decision } from '../../lib/types';
import {
  AccessDeniedError,
  EnforcementPlan,
  EnforcementResult,
  absentMaybe,
  presentMaybe,
} from '../../lib/streaming/MealyMachine';
import {
  StreamingPipelineConfig,
  classify,
  createStreamingPipeline,
} from '../../lib/streaming/StreamingPipeline';
import { AccessGrantedSignal, AccessSuspendedSignal } from '../../lib/streaming/BoundarySignals';

const decisionFor = (verb: Decision): AuthorizationDecision => ({ decision: verb });

const passthroughPlan = (): EnforcementPlan => ({
  enforceDecisionConstraints: () => false,
  executePerItem: (value) => ({ failureState: false, value: presentMaybe(value) }),
});

class Harness {
  pdp = new Subject<AuthorizationDecision>();
  rap = new Subject<unknown>();
  rapSupplierInvocations = 0;
  plan: EnforcementPlan = passthroughPlan();
  pauseRapDuringSuspend = false;
  signalTransitions = false;

  create(): Observable<unknown> {
    const config: StreamingPipelineConfig = {
      pauseRapDuringSuspend: this.pauseRapDuringSuspend,
      decisions: this.pdp.asObservable(),
      planner: () => this.plan,
      rapSupplier: () => {
        this.rapSupplierInvocations += 1;
        return this.rap.asObservable();
      },
      signalTransitions: this.signalTransitions,
    };
    return createStreamingPipeline(config);
  }

  emitPermit(): void {
    this.pdp.next(decisionFor('PERMIT'));
  }

  emitSuspend(): void {
    this.pdp.next(decisionFor('SUSPEND'));
  }

  emitDeny(): void {
    this.pdp.next(decisionFor('DENY'));
  }

  completePdp(): void {
    this.pdp.complete();
  }

  errorPdp(error: unknown): void {
    this.pdp.error(error);
  }

  emitRap(value: unknown): void {
    this.rap.next(value);
  }

  completeRap(): void {
    this.rap.complete();
  }

  errorRap(error: unknown): void {
    this.rap.error(error);
  }

  replaceRap(): void {
    this.rap = new Subject<unknown>();
  }
}

interface Recorder<T> {
  readonly values: T[];
  error: unknown;
  complete: boolean;
  readonly subscription: Subscription;
}

const record = <T>(observable: Observable<T>): Recorder<T> => {
  const state: { values: T[]; error: unknown; complete: boolean; subscription?: Subscription } = {
    values: [],
    error: undefined,
    complete: false,
  };
  state.subscription = observable.subscribe({
    next: (value) => state.values.push(value),
    error: (error: unknown) => {
      state.error = error;
    },
    complete: () => {
      state.complete = true;
    },
  });
  return state as Recorder<T>;
};

describe('classify', () => {
  const plan: EnforcementPlan = passthroughPlan();

  test.each<[Decision, boolean, string]>([
    ['PERMIT', false, 'PdpPermit'],
    ['PERMIT', true, 'PdpDeny'],
    ['SUSPEND', false, 'PdpSuspend'],
    ['SUSPEND', true, 'PdpSuspend'],
    ['INDETERMINATE', false, 'PdpDeny'],
    ['INDETERMINATE', true, 'PdpDeny'],
    ['NOT_APPLICABLE', false, 'PdpDeny'],
    ['NOT_APPLICABLE', true, 'PdpDeny'],
    ['DENY', false, 'PdpDeny'],
    ['DENY', true, 'PdpDeny'],
  ])('when verb=%s failed=%s then produces $#-th expected event', (verb, failed, expectedEventType) => {
    const event = classify(decisionFor(verb), plan, failed);

    expect(event.type).toBe(expectedEventType);
  });

  test.each<[Decision, boolean, RegExp]>([
    ['PERMIT', true, /decision-scoped/i],
    ['INDETERMINATE', false, /indeterminate/i],
    ['NOT_APPLICABLE', false, /no applicable policy/i],
    ['DENY', false, /denied by policy/i],
    ['DENY', true, /denied by policy/i],
  ])('when verb=%s failed=%s then PdpDeny reason matches', (verb, failed, expectedPattern) => {
    const event = classify(decisionFor(verb), plan, failed);

    if (event.type !== 'PdpDeny') throw new Error(`expected PdpDeny got ${event.type}`);
    expect(event.reason).toMatch(expectedPattern);
  });

  test('whenSuspendThenEventCarriesTransitionReasonWithDecision', () => {
    const decision = decisionFor('SUSPEND');
    const event = classify(decision, plan, false);

    if (event.type !== 'PdpSuspend') throw new Error(`expected PdpSuspend got ${event.type}`);
    expect(event.reason.type).toBe('Suspended');
    if (event.reason.type !== 'Suspended') throw new Error('narrowing invariant violated');
    expect(event.reason.decision).toBe(decision);
  });

  test('whenPermitWithoutDecisionScopedFailureThenProducesPdpPermitCarryingPlan', () => {
    const decision = decisionFor('PERMIT');
    const event = classify(decision, plan, false);

    if (event.type !== 'PdpPermit') throw new Error(`expected PdpPermit got ${event.type}`);
    expect(event.decision).toBe(decision);
    expect(event.plan).toBe(plan);
  });
});

describe('StreamingPipeline: item flow', () => {
  test('whenSubscribedBeforeFirstPermitThenRapSupplierIsNotInvoked', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitSuspend();

    expect(harness.rapSupplierInvocations).toBe(0);
    recorder.subscription.unsubscribe();
  });

  test('whenFirstPermitThenRapSupplierIsInvokedOnce', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();

    expect(harness.rapSupplierInvocations).toBe(1);
    recorder.subscription.unsubscribe();
  });

  test('whenPermittingThenRapItemsAreEmittedDownstream', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    harness.emitRap('b');

    expect(recorder.values).toEqual(['a', 'b']);
    recorder.subscription.unsubscribe();
  });

  test('whenSuspendedThenSubscriberSeesZeroRealValuesAcrossManyEmissions', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('permit-1');
    harness.emitSuspend();
    for (let i = 0; i < 100; i += 1) {
      harness.emitRap(`suspended-${i}`);
    }

    // Only the pre-suspend value should have reached the subscriber.
    expect(recorder.values).toEqual(['permit-1']);
    expect(recorder.complete).toBe(false);
    expect(recorder.error).toBeUndefined();
    recorder.subscription.unsubscribe();
  });

  test('whenSuspendedThenRapItemsAreDroppedSilently', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    harness.emitSuspend();
    harness.emitRap('dropped-1');
    harness.emitRap('dropped-2');

    expect(recorder.values).toEqual(['a']);
    expect(recorder.complete).toBe(false);
    recorder.subscription.unsubscribe();
  });

  test('whenResumedAfterSuspendThenItemsFlowAgain', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    harness.emitSuspend();
    harness.emitRap('dropped');
    harness.emitPermit();
    harness.emitRap('b');

    expect(recorder.values).toEqual(['a', 'b']);
    recorder.subscription.unsubscribe();
  });

  test('whenPerItemEnforcementFailsThenSubscriberErrorsWithAccessDeniedError', () => {
    const harness = new Harness();
    harness.plan = {
      enforceDecisionConstraints: () => false,
      executePerItem: (): EnforcementResult<unknown> => ({ failureState: true, value: absentMaybe }),
    };
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('doomed');

    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
    recorder.subscription.unsubscribe();
  });

  test('whenPlanReturnsAbsentForItemThenItemIsDroppedSilently', () => {
    const harness = new Harness();
    harness.plan = {
      enforceDecisionConstraints: () => false,
      executePerItem: (): EnforcementResult<unknown> => ({ failureState: false, value: absentMaybe }),
    };
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('mapped-away');

    expect(recorder.values).toEqual([]);
    expect(recorder.complete).toBe(false);
    recorder.subscription.unsubscribe();
  });

  test('whenPermittingThenPlanExecutePerItemIsCalledOncePerItem', () => {
    const harness = new Harness();
    const executePerItem = jest.fn(
      (value: unknown): EnforcementResult<unknown> => ({
        failureState: false,
        value: presentMaybe(value),
      }),
    );
    harness.plan = { enforceDecisionConstraints: () => false, executePerItem };
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    harness.emitRap('b');
    harness.emitRap('c');

    expect(executePerItem).toHaveBeenCalledTimes(3);
    expect(recorder.values).toEqual(['a', 'b', 'c']);
    recorder.subscription.unsubscribe();
  });

  test('whenSuspendedThenPlanExecutePerItemIsNotCalled', () => {
    const harness = new Harness();
    const executePerItem = jest.fn(
      (value: unknown): EnforcementResult<unknown> => ({
        failureState: false,
        value: presentMaybe(value),
      }),
    );
    harness.plan = { enforceDecisionConstraints: () => false, executePerItem };
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('permitted');
    harness.emitSuspend();
    harness.emitRap('suspended-a');
    harness.emitRap('suspended-b');

    expect(executePerItem).toHaveBeenCalledTimes(1);
    recorder.subscription.unsubscribe();
  });
});

describe('StreamingPipeline: lifecycle', () => {
  test('whenRapCompletesThenSubscriberCompletes', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.completeRap();

    expect(recorder.complete).toBe(true);
    expect(recorder.error).toBeUndefined();
  });

  test('whenRapErrorsThenSubscriberErrorsWithSameThrowable', () => {
    const harness = new Harness();
    const recorder = record(harness.create());
    const boom = new Error('rap boom');

    harness.emitPermit();
    harness.errorRap(boom);

    expect(recorder.error).toBe(boom);
  });

  test('whenPdpErrorsThenSubscriberErrorsWithSameThrowable', () => {
    const harness = new Harness();
    const recorder = record(harness.create());
    const boom = new Error('pdp boom');

    harness.errorPdp(boom);

    expect(recorder.error).toBe(boom);
  });

  test('whenPdpEmitsDenyThenSubscriberErrorsWithAccessDeniedError', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitDeny();

    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
  });

  test('whenPdpCompletesWithoutDecisionThenTreatedAsDenyAndSubscriberErrors', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.completePdp();

    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
  });

  test('whenSignalTransitionsTrueThenSuspendBoundaryArrivesAsAccessSuspendedSignalOnNext', () => {
    const harness = new Harness();
    harness.signalTransitions = true;
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    harness.emitSuspend();

    expect(recorder.values).toHaveLength(3);
    expect(recorder.values[0]).toBeInstanceOf(AccessGrantedSignal);
    expect(recorder.values[1]).toBe('a');
    expect(recorder.values[2]).toBeInstanceOf(AccessSuspendedSignal);
    expect(recorder.complete).toBe(false);
    recorder.subscription.unsubscribe();
  });

  test('whenSignalTransitionsFalseThenBoundarySignalsAreInvisible', () => {
    const harness = new Harness();
    harness.signalTransitions = false;
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    harness.emitSuspend();
    harness.emitPermit();
    harness.emitRap('b');

    expect(recorder.values).toEqual(['a', 'b']);
    recorder.subscription.unsubscribe();
  });

  test('whenSignalTransitionsTrueThenGrantedBoundaryArrivesAsAccessGrantedSignalOnNext', () => {
    const harness = new Harness();
    harness.signalTransitions = true;
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitSuspend();
    harness.emitPermit();
    harness.emitRap('after-resume');

    const grantedBoundaries = recorder.values.filter((v) => v instanceof AccessGrantedSignal);
    const suspendBoundaries = recorder.values.filter((v) => v instanceof AccessSuspendedSignal);
    expect(grantedBoundaries).toHaveLength(2);
    expect(suspendBoundaries).toHaveLength(1);
    expect(recorder.values).toContain('after-resume');
    recorder.subscription.unsubscribe();
  });

  test('whenPauseRapDuringSuspendTrueThenRapSupplierIsInvokedOncePerPermit', () => {
    const harness = new Harness();
    harness.pauseRapDuringSuspend = true;
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitSuspend();
    harness.replaceRap();
    harness.emitPermit();

    expect(harness.rapSupplierInvocations).toBe(2);
    recorder.subscription.unsubscribe();
  });

  test('whenPauseRapDuringSuspendFalseThenRapSupplierIsInvokedOnce', () => {
    const harness = new Harness();
    harness.pauseRapDuringSuspend = false;
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitSuspend();
    harness.emitPermit();

    expect(harness.rapSupplierInvocations).toBe(1);
    recorder.subscription.unsubscribe();
  });

  test('whenMultiplePermitsArriveWhileInPermittingThenRapSupplierInvokedOnlyOnce', () => {
    // Consecutive PERMITs while already in Permitting are plan replans and
    // must not trigger RAP re-subscription regardless of pauseRapDuringSuspend.
    for (const pauseFlag of [false, true]) {
      const harness = new Harness();
      harness.pauseRapDuringSuspend = pauseFlag;
      const recorder = record(harness.create());

      harness.emitPermit();
      harness.emitPermit();
      harness.emitPermit();

      expect(harness.rapSupplierInvocations).toBe(1);
      recorder.subscription.unsubscribe();
    }
  });

  test('whenSubscriberUnsubscribesThenBothInnerSubscriptionsAreReleased', () => {
    const harness = new Harness();
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitRap('a');
    recorder.subscription.unsubscribe();

    expect(harness.pdp.observed).toBe(false);
    expect(harness.rap.observed).toBe(false);
  });

  test('whenMultipleConsecutivePermitsThenSingleBoundarySignalForInitialGrant', () => {
    const harness = new Harness();
    harness.signalTransitions = true;
    const recorder = record(harness.create());

    harness.emitPermit();
    harness.emitPermit();
    harness.emitPermit();
    harness.emitRap('a');

    const grantedBoundaries = recorder.values.filter((v) => v instanceof AccessGrantedSignal);
    expect(grantedBoundaries).toHaveLength(1);
    expect(recorder.values).toContain('a');
    recorder.subscription.unsubscribe();
  });
});
