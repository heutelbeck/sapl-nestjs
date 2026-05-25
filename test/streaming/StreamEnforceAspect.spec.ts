import { Observable, Subject, of } from 'rxjs';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { PdpService } from '../../lib/pdp.service';
import { AccessDeniedError } from '../../lib/streaming/MealyMachine';
import { AccessGrantedSignal, AccessSuspendedSignal } from '../../lib/streaming/BoundarySignals';
import { StreamEnforceAspect } from '../../lib/streaming/StreamEnforceAspect';
import { StreamEnforceOptions } from '../../lib/streaming/StreamEnforce';
import type { ConstraintHandlerProvider } from '../../lib/constraints/api/index';
import type { AuthorizationDecision } from '../../lib/types';
import { createMockClsService } from '../test-helpers';

const PERMIT: AuthorizationDecision = { decision: 'PERMIT' };
const SUSPEND: AuthorizationDecision = { decision: 'SUSPEND' };
const DENY: AuthorizationDecision = { decision: 'DENY' };

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

const plannerWithProviders = (providers: ConstraintHandlerProvider[]): EnforcementPlanner => {
  const registry: ProviderRegistry = { all: () => providers } as unknown as ProviderRegistry;
  return new EnforcementPlanner(registry);
};

describe('StreamEnforceAspect', () => {
  let pdpService: Partial<PdpService>;
  let aspect: StreamEnforceAspect;
  let clsMock: ReturnType<typeof createMockClsService>;
  let decisions: Subject<AuthorizationDecision>;
  let providers: ConstraintHandlerProvider[];

  beforeEach(() => {
    decisions = new Subject<AuthorizationDecision>();
    pdpService = { decide: jest.fn().mockReturnValue(decisions.asObservable()) };
    providers = [];
    clsMock = createMockClsService();
    aspect = new StreamEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      plannerWithProviders(providers),
    );
  });

  afterEach(() => {
    if (!decisions.closed) {
      decisions.complete();
    }
  });

  const wrapMethod = (
    method: (...args: any[]) => Observable<unknown>,
    metadata: StreamEnforceOptions = {},
    methodName = 'streamHandler',
    instance: object = { constructor: { name: 'StreamController' } },
  ): ((...args: unknown[]) => Observable<unknown>) => {
    return aspect.wrap({ method, metadata, methodName, instance } as any);
  };

  test('whenPermitArrivesThenProtectedMethodIsInvokedAndItemsFlow', () => {
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(PERMIT);
    rap.next('a');
    rap.next('b');

    expect(method).toHaveBeenCalledTimes(1);
    expect(recorder.values).toEqual(['a', 'b']);
  });

  test('whenDenyArrivesThenSubscriberErrorsWithAccessDeniedError', () => {
    const method = jest.fn().mockReturnValue(new Subject().asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(DENY);

    expect(method).not.toHaveBeenCalled();
    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
  });

  test('whenSuspendArrivesThenItemsAreDroppedAndSubscriberStaysOpen', () => {
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(PERMIT);
    rap.next('a');
    decisions.next(SUSPEND);
    rap.next('dropped');

    expect(recorder.values).toEqual(['a']);
    expect(recorder.complete).toBe(false);
    expect(recorder.error).toBeUndefined();
  });

  test('whenSignalTransitionsTrueThenBoundarySignalsArriveOnNext', () => {
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method, { signalTransitions: true })());

    decisions.next(PERMIT);
    rap.next('a');
    decisions.next(SUSPEND);

    expect(recorder.values).toHaveLength(3);
    expect(recorder.values[0]).toBeInstanceOf(AccessGrantedSignal);
    expect(recorder.values[1]).toBe('a');
    expect(recorder.values[2]).toBeInstanceOf(AccessSuspendedSignal);
  });

  test('whenSignalTransitionsFalseThenBoundarySignalsAreSilent', () => {
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method, { signalTransitions: false })());

    decisions.next(PERMIT);
    rap.next('a');
    decisions.next(SUSPEND);
    decisions.next(PERMIT);
    rap.next('b');

    expect(recorder.values).toEqual(['a', 'b']);
  });

  test('whenPauseRapDuringSuspendTrueThenProtectedMethodIsReinvokedOnResume', () => {
    const method = jest.fn().mockImplementation(() => new Subject().asObservable());
    const recorder = record(wrapMethod(method, { pauseRapDuringSuspend: true })());

    decisions.next(PERMIT);
    decisions.next(SUSPEND);
    decisions.next(PERMIT);

    expect(method).toHaveBeenCalledTimes(2);
    expect(recorder.values).toEqual([]);
  });

  test('whenPerItemConstraintHandlerThrowsThenSubscriberErrorsWithAccessDenied', () => {
    providers.push({
      getHandlers: () => [
        {
          signal: 'output',
          priority: 0,
          shape: 'consumer',
          handler: () => {
            throw new Error('obligation failed');
          },
        },
      ],
    });
    pdpService = { decide: jest.fn().mockImplementation(() => decisions.asObservable()) };
    aspect = new StreamEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      plannerWithProviders(providers),
    );
    const obligationDecision: AuthorizationDecision = { decision: 'PERMIT', obligations: [{ type: 'X' }] };
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(obligationDecision);
    rap.next('bad');

    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
  });

  test('whenDecisionScopedConstraintHandlerThrowsThenPermitIsReclassifiedAsDeny', () => {
    providers.push({
      getHandlers: () => [
        {
          signal: 'decision',
          priority: 0,
          shape: 'runner',
          handler: () => {
            throw new Error('decision-scoped failed');
          },
        },
      ],
    });
    pdpService = { decide: jest.fn().mockImplementation(() => decisions.asObservable()) };
    aspect = new StreamEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      plannerWithProviders(providers),
    );
    const obligationDecision: AuthorizationDecision = { decision: 'PERMIT', obligations: [{ type: 'X' }] };
    const method = jest.fn().mockReturnValue(new Subject().asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(obligationDecision);

    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
    expect(method).not.toHaveBeenCalled();
  });

  test('whenConstraintHandlerMapsValueThenSubscriberReceivesMappedValue', () => {
    providers.push({
      getHandlers: () => [
        {
          signal: 'output',
          priority: 0,
          shape: 'mapper',
          handler: (v) => (v as string).toUpperCase(),
        },
      ],
    });
    pdpService = { decide: jest.fn().mockImplementation(() => decisions.asObservable()) };
    aspect = new StreamEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      plannerWithProviders(providers),
    );
    const obligationDecision: AuthorizationDecision = { decision: 'PERMIT', obligations: [{ type: 'X' }] };
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(obligationDecision);
    rap.next('hello');

    expect(recorder.values).toEqual(['HELLO']);
  });

  test('whenConstraintHandlerReturnsNullThenItemIsDroppedSilently', () => {
    providers.push({
      getHandlers: () => [
        {
          signal: 'output',
          priority: 0,
          shape: 'mapper',
          handler: () => null,
        },
      ],
    });
    pdpService = { decide: jest.fn().mockImplementation(() => decisions.asObservable()) };
    aspect = new StreamEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      plannerWithProviders(providers),
    );
    const obligationDecision: AuthorizationDecision = { decision: 'PERMIT', obligations: [{ type: 'X' }] };
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(obligationDecision);
    rap.next('to-be-filtered');

    expect(recorder.values).toEqual([]);
    expect(recorder.complete).toBe(false);
  });

  test('whenRapCompletesThenSubscriberCompletes', () => {
    const rap = new Subject<string>();
    const method = jest.fn().mockReturnValue(rap.asObservable());
    const recorder = record(wrapMethod(method)());

    decisions.next(PERMIT);
    rap.complete();

    expect(recorder.complete).toBe(true);
  });

  test('whenEmptyPdpFluxThenSubscriberErrorsWithAccessDeniedError', () => {
    (pdpService.decide as jest.Mock).mockReturnValue(of(...([] as AuthorizationDecision[])));
    const method = jest.fn().mockReturnValue(new Subject().asObservable());
    const recorder = record(wrapMethod(method)());

    expect(recorder.error).toBeInstanceOf(AccessDeniedError);
    expect(method).not.toHaveBeenCalled();
  });
});
