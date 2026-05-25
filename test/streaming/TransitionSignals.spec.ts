import { Observable, Subject } from 'rxjs';
import type { AuthorizationDecision } from '../../lib/types';
import { AccessSuspendedSignal, AccessGrantedSignal } from '../../lib/streaming/BoundarySignals';
import { TransitionSignals } from '../../lib/streaming/TransitionSignals';

const PERMIT_DECISION: AuthorizationDecision = { decision: 'PERMIT' };

interface Recorder<T> {
  values: T[];
  error: unknown;
  complete: boolean;
}

const record = <T>(observable: Observable<T>): Recorder<T> => {
  const state: Recorder<T> = { values: [], error: undefined, complete: false };
  observable.subscribe({
    next: (value) => state.values.push(value),
    error: (error: unknown) => {
      state.error = error;
    },
    complete: () => {
      state.complete = true;
    },
  });
  return state;
};

describe('TransitionSignals.onSuspend', () => {
  test('whenObserveOnlyAndSuspendSignalArrivesThenConsumerCalledAndSignalFiltered', () => {
    const source = new Subject<unknown>();
    const calls: AccessSuspendedSignal[] = [];
    const recorder = record(TransitionSignals.onSuspend(source, (e) => calls.push(e)));

    source.next('a');
    source.next(new AccessSuspendedSignal());
    source.next('b');

    expect(recorder.values).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AccessSuspendedSignal);
  });

  test('whenObserveOnlyAndNoSuspendSignalsThenValuesPassThroughUnchanged', () => {
    const source = new Subject<unknown>();
    const calls: AccessSuspendedSignal[] = [];
    const recorder = record(TransitionSignals.onSuspend(source, (e) => calls.push(e)));

    source.next('x');
    source.next('y');

    expect(recorder.values).toEqual(['x', 'y']);
    expect(calls).toHaveLength(0);
  });

  test('whenSubstituteProvidedAndSuspendSignalArrivesThenSubstituteEmittedAndConsumerCalled', () => {
    const source = new Subject<string>();
    const calls: AccessSuspendedSignal[] = [];
    const recorder = record(
      TransitionSignals.onSuspend(
        source,
        (e) => calls.push(e),
        () => 'SUBSTITUTE',
      ),
    );

    source.next('a');
    source.next(new AccessSuspendedSignal() as unknown as string);
    source.next('b');

    expect(recorder.values).toEqual(['a', 'SUBSTITUTE', 'b']);
    expect(calls).toHaveLength(1);
  });

  test('whenObserveOnlyAndGrantedSignalArrivesThenValuePassesThroughBecauseOnlySuspendIsFiltered', () => {
    const source = new Subject<unknown>();
    const calls: AccessSuspendedSignal[] = [];
    const recorder = record(TransitionSignals.onSuspend(source, (e) => calls.push(e)));
    const grantedSignal = new AccessGrantedSignal(PERMIT_DECISION);

    source.next(grantedSignal);

    expect(recorder.values).toEqual([grantedSignal]);
    expect(calls).toHaveLength(0);
  });
});

describe('TransitionSignals.onGranted', () => {
  test('whenObserveOnlyAndGrantedSignalArrivesThenConsumerCalledAndSignalFiltered', () => {
    const source = new Subject<unknown>();
    const calls: AccessGrantedSignal[] = [];
    const recorder = record(TransitionSignals.onGranted(source, (e) => calls.push(e)));

    source.next('a');
    source.next(new AccessGrantedSignal(PERMIT_DECISION));
    source.next('b');

    expect(recorder.values).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0].decision).toBe(PERMIT_DECISION);
  });

  test('whenSubstituteProvidedAndGrantedSignalArrivesThenSubstituteEmittedAndConsumerCalled', () => {
    const source = new Subject<string>();
    const calls: AccessGrantedSignal[] = [];
    const recorder = record(
      TransitionSignals.onGranted(
        source,
        (e) => calls.push(e),
        () => 'RESUMED',
      ),
    );

    source.next('a');
    source.next(new AccessGrantedSignal(PERMIT_DECISION) as unknown as string);

    expect(recorder.values).toEqual(['a', 'RESUMED']);
    expect(calls).toHaveLength(1);
  });

  test('whenObserveOnlyAndSuspendSignalArrivesThenValuePassesThroughBecauseOnlyGrantIsFiltered', () => {
    const source = new Subject<unknown>();
    const calls: AccessGrantedSignal[] = [];
    const recorder = record(TransitionSignals.onGranted(source, (e) => calls.push(e)));
    const suspendSignal = new AccessSuspendedSignal();

    source.next(suspendSignal);

    expect(recorder.values).toEqual([suspendSignal]);
    expect(calls).toHaveLength(0);
  });
});

describe('TransitionSignals.onTransitions', () => {
  test('whenObserveOnlyThenBothBoundariesInvokeConsumersAndAreFiltered', () => {
    const source = new Subject<unknown>();
    const suspendCalls: AccessSuspendedSignal[] = [];
    const grantCalls: AccessGrantedSignal[] = [];
    const recorder = record(
      TransitionSignals.onTransitions(
        source,
        (e) => suspendCalls.push(e),
        (e) => grantCalls.push(e),
      ),
    );

    source.next(new AccessGrantedSignal(PERMIT_DECISION));
    source.next('a');
    source.next(new AccessSuspendedSignal());
    source.next('b');

    expect(recorder.values).toEqual(['a', 'b']);
    expect(suspendCalls).toHaveLength(1);
    expect(grantCalls).toHaveLength(1);
  });

  test('whenSubstitutesProvidedThenBothBoundariesEmitTheirSubstitute', () => {
    const source = new Subject<string>();
    const recorder = record(
      TransitionSignals.onTransitions(
        source,
        () => undefined,
        () => 'SUSPENDED-PLACEHOLDER',
        () => undefined,
        () => 'GRANTED-PLACEHOLDER',
      ),
    );

    source.next('a');
    source.next(new AccessGrantedSignal(PERMIT_DECISION) as unknown as string);
    source.next(new AccessSuspendedSignal() as unknown as string);
    source.next('b');

    expect(recorder.values).toEqual(['a', 'GRANTED-PLACEHOLDER', 'SUSPENDED-PLACEHOLDER', 'b']);
  });
});
