import { Logger } from '@nestjs/common';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { ContentFilteringProvider } from '../../lib/constraints/providers/ContentFilteringProvider';
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
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return planner;
};

const decisionWith = (overrides: Partial<AuthorizationDecision>): AuthorizationDecision => ({
  decision: 'PERMIT',
  ...overrides,
});

// Spring EnforcementPlanner.claimHandlers (CC-04) wraps every provider
// resolution in a try/catch: a provider that throws during planning is logged
// and treated as returning no handlers, so a malformed constraint fails closed
// via the synthetic substitute path rather than escaping plan().
describe('EnforcementPlanner provider resolution failures (CC-04)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('a provider that throws while resolving a constraint', () => {
    test('whenProviderThrowsDuringPlanningThenPlanDoesNotThrow', () => {
      const exploding = provider(() => {
        throw new Error('provider blew up while resolving');
      });
      const planner = plannerWith([exploding]);

      const buildPlan = () => planner.plan(decisionWith({ obligations: [{ type: 'X' }] }), ALL_SIGNALS);

      expect(buildPlan).not.toThrow();
    });

    test('whenProviderThrowsForObligationThenTreatedAsNoClaimAndFailsClosed', () => {
      const exploding = provider(() => {
        throw new Error('provider blew up while resolving');
      });
      const plan = plannerWith([exploding]).plan(decisionWith({ obligations: [{ type: 'X' }] }), ALL_SIGNALS);

      const result = plan.execute({ kind: 'decision', value: decisionWith({}) });

      expect(result.failureState).toBe(true);
    });

    test('whenOneProviderThrowsThenOtherWellFormedConstraintsStillEnforced', () => {
      let goodInvoked = 0;
      const exploding = provider((c) => {
        if ((c as { type?: unknown }).type === 'bad') {
          throw new Error('provider blew up while resolving');
        }
        return [];
      });
      const good = provider((c) =>
        (c as { type?: unknown }).type === 'good'
          ? [
              triple({
                signal: 'output',
                shape: 'consumer',
                handler: () => {
                  goodInvoked += 1;
                },
              }),
            ]
          : [],
      );
      const plan = plannerWith([exploding, good]).plan(
        decisionWith({ obligations: [{ type: 'bad' }, { type: 'good' }] }),
        ALL_SIGNALS,
      );

      plan.execute({ kind: 'output', value: 'v' });
      const decisionResult = plan.execute({ kind: 'decision', value: decisionWith({}) });

      expect(goodInvoked).toBe(1);
      expect(decisionResult.failureState).toBe(true);
    });
  });

  describe('content filtering obligation with an unsafe regex condition', () => {
    const catastrophicRegexObligation = {
      type: 'filterJsonContent',
      conditions: [{ path: '$.x', type: '=~', value: '(a+)+$' }],
      actions: [{ type: 'blacken', path: '$.x' }],
    };

    test('whenContentFilterRejectsUnsafeRegexDuringPlanningThenPlanDoesNotThrow', () => {
      const planner = plannerWith([new ContentFilteringProvider()]);

      const buildPlan = () =>
        planner.plan(decisionWith({ obligations: [catastrophicRegexObligation] }), ALL_SIGNALS);

      expect(buildPlan).not.toThrow();
    });

    test('whenContentFilterRejectsUnsafeRegexThenObligationFailsClosed', () => {
      const plan = plannerWith([new ContentFilteringProvider()]).plan(
        decisionWith({ obligations: [catastrophicRegexObligation] }),
        ALL_SIGNALS,
      );

      const result = plan.execute({ kind: 'decision', value: decisionWith({}) });

      expect(result.failureState).toBe(true);
    });
  });
});
