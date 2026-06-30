import { Observable, Subject } from 'rxjs';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { PdpService } from '../../lib/pdp.service';
import { AccessDeniedError } from '../../lib/streaming/MealyMachine';
import { StreamEnforceAspect } from '../../lib/streaming/StreamEnforceAspect';
import { StreamEnforceOptions } from '../../lib/streaming/StreamEnforce';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import type { AuthorizationDecision } from '../../lib/types';
import { createMockClsService } from '../test-helpers';

/**
 * CC-03: void lifecycle-signal obligation failures must deny the stream.
 *
 * Mirrors Spring EnforcementPlan.enforceConstraintsOrThrow
 * (sapl-spring-boot-starter EnforcementPlan.java:289-293): firing a void
 * lifecycle signal whose obligation handler fails raises an at-signal
 * AccessDeniedException rather than being swallowed. The subscribe signal
 * gates before any RAP data is allowed to flow.
 */
describe('Lifecycle-signal obligation enforcement (stream)', () => {
  const PERMIT_WITH_OBLIGATION: AuthorizationDecision = {
    decision: 'PERMIT',
    obligations: [{ type: 'lifecycle' }],
  };

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

  let decisions: Subject<AuthorizationDecision>;
  let clsMock: ReturnType<typeof createMockClsService>;

  const failingRunnerAt = (signal: ScopedHandler['signal']): ConstraintHandlerProvider => ({
    getHandlers: () => [
      {
        signal,
        priority: 0,
        shape: 'runner',
        handler: () => {
          throw new Error(`${signal} obligation failed`);
        },
      },
    ],
  });

  const aspectWith = (provider: ConstraintHandlerProvider): StreamEnforceAspect => {
    const registry: ProviderRegistry = { all: () => [provider] } as unknown as ProviderRegistry;
    const pdpService: Partial<PdpService> = {
      decide: jest.fn().mockReturnValue(decisions.asObservable()),
    };
    return new StreamEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      new EnforcementPlanner(registry),
    );
  };

  const wrap = (
    aspect: StreamEnforceAspect,
    method: (...args: any[]) => Observable<unknown>,
    metadata: StreamEnforceOptions = {},
  ): ((...args: unknown[]) => Observable<unknown>) =>
    aspect.wrap({
      method,
      metadata,
      methodName: 'streamHandler',
      instance: { constructor: { name: 'StreamController' } },
    } as any);

  beforeEach(() => {
    decisions = new Subject<AuthorizationDecision>();
    clsMock = createMockClsService();
  });

  afterEach(() => {
    if (!decisions.closed) {
      decisions.complete();
    }
  });

  describe('subscribe signal gates before any data flows', () => {
    test('whenSubscribeObligationFailsThenSubscriberErrorsAndNoItemsFlow', () => {
      const aspect = aspectWith(failingRunnerAt('subscribe'));
      const rap = new Subject<string>();
      const method = jest.fn().mockReturnValue(rap.asObservable());
      const recorder = record(wrap(aspect, method)());

      decisions.next(PERMIT_WITH_OBLIGATION);
      rap.next('leaked');

      expect(recorder.error).toBeInstanceOf(AccessDeniedError);
      expect(recorder.values).toEqual([]);
    });
  });

  describe('terminal signals deny on obligation failure', () => {
    test('whenCompleteObligationFailsThenSubscriberErrorsInsteadOfCompleting', () => {
      const aspect = aspectWith(failingRunnerAt('complete'));
      const rap = new Subject<string>();
      const method = jest.fn().mockReturnValue(rap.asObservable());
      const recorder = record(wrap(aspect, method)());

      decisions.next(PERMIT_WITH_OBLIGATION);
      rap.next('a');
      rap.complete();

      expect(recorder.error).toBeInstanceOf(AccessDeniedError);
      expect(recorder.complete).toBe(false);
    });
  });
});
