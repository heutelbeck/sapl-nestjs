import { PreEnforceAspect } from '../../lib/PreEnforceAspect';
import { PdpService } from '../../lib/pdp.service';
import { EnforcementPlanner } from '../../lib/constraints/Planner';
import { ProviderRegistry } from '../../lib/constraints/ProviderRegistry';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import type { ConstraintHandlerProvider, ScopedHandler } from '../../lib/constraints/api/index';
import { createMockClsService, createMockTransactionAdapter } from '../test-helpers';

/**
 * Fail-closed enforcement parity with the Spring PEP
 * (io.sapl.spring.pep.constraints.EnforcementPlan). These scenarios pin
 * the security-relevant edges where a PreEnforce obligation handler
 * itself fails: error-signal escalation, unconditional pre-invocation
 * signalling, the post-invocation side-effect warning, and void output
 * handling. Covers findings BP-12, CC-02, CC-07, AP-10, CC-10.
 */
describe('PreEnforceAspect fail-closed enforcement', () => {
  let pdpService: Partial<PdpService>;
  let clsMock: ReturnType<typeof createMockClsService>;

  const buildAspect = (planner: EnforcementPlanner) =>
    new PreEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      planner,
      createMockTransactionAdapter(false) as any,
    );

  // A single provider that claims every constraint and emits the given
  // scoped handlers. One obligation in the decision then yields exactly
  // this handler set as obligation-tagged plan entries.
  const plannerWith = (handlers: ScopedHandler[]): EnforcementPlanner => {
    const provider: ConstraintHandlerProvider = { getHandlers: () => handlers };
    const registry = {
      all: () => (handlers.length > 0 ? [provider] : []),
    } as unknown as ProviderRegistry;
    return new EnforcementPlanner(registry);
  };

  const permitWithObligation = { decision: 'PERMIT', obligations: [{ type: 'enforced' }] };

  const wrap = (aspect: PreEnforceAspect, method: (...args: any[]) => any) =>
    aspect.wrap({
      method,
      metadata: {},
      methodName: 'testHandler',
      instance: { constructor: { name: 'TestController' } },
    } as any);

  beforeEach(() => {
    pdpService = { decideOnce: jest.fn() };
    clsMock = createMockClsService();
  });

  describe('error-signal obligation failure', () => {
    test('whenErrorSignalObligationHandlerThrowsThenAccessDeniedNotOriginalError', async () => {
      // BP-12 / CC-02: an error-signal obligation meant to scrub or audit
      // the failure throws at runtime. Spring escalates to a fresh
      // AccessDeniedException rather than letting the raw method error
      // (potentially carrying sensitive text) reach the caller.
      (pdpService.decideOnce as jest.Mock).mockResolvedValue(permitWithObligation);
      const errorObligation: ScopedHandler = {
        signal: 'error',
        priority: 0,
        shape: 'consumer',
        handler: () => {
          throw new Error('audit sink unavailable');
        },
      };
      const aspect = buildAspect(plannerWith([errorObligation]));
      const sensitive = new Error('internal db password=hunter2');
      const method = jest.fn().mockRejectedValue(sensitive);

      const invoke = wrap(aspect, method);

      await expect(invoke()).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(invoke()).rejects.not.toBe(sensitive);
    });

    test('whenErrorSignalObligationSucceedsThenOriginalErrorPassesThrough', async () => {
      // Counterpart: when no error-signal obligation fails and no Mapper
      // replaces the throwable, the original error passes through.
      (pdpService.decideOnce as jest.Mock).mockResolvedValue(permitWithObligation);
      const observed: unknown[] = [];
      const errorObligation: ScopedHandler = {
        signal: 'error',
        priority: 0,
        shape: 'consumer',
        handler: (value) => {
          observed.push(value);
        },
      };
      const aspect = buildAspect(plannerWith([errorObligation]));
      const original = new Error('boom');
      const method = jest.fn().mockRejectedValue(original);

      await expect(wrap(aspect, method)()).rejects.toBe(original);
      expect(observed).toHaveLength(1);
    });
  });

  describe('pre-invocation signalling order', () => {
    test('whenDecisionObligationFailsThenInputSignalStillFiresBeforeDeny', async () => {
      // CC-07: Spring fires the input signal unconditionally even after a
      // decision-scoped obligation has already failed, then denies once.
      // Input-scoped audit handlers must not be skipped.
      (pdpService.decideOnce as jest.Mock).mockResolvedValue(permitWithObligation);
      let inputHandlerRan = false;
      const failingDecision: ScopedHandler = {
        signal: 'decision',
        priority: 0,
        shape: 'runner',
        handler: () => {
          throw new Error('decision audit failed');
        },
      };
      const inputAudit: ScopedHandler = {
        signal: 'input',
        priority: 0,
        shape: 'runner',
        handler: () => {
          inputHandlerRan = true;
        },
      };
      const aspect = buildAspect(plannerWith([failingDecision, inputAudit]));
      const method = jest.fn().mockResolvedValue({ ok: true });

      await expect(wrap(aspect, method)()).rejects.toBeInstanceOf(AccessDeniedError);
      expect(inputHandlerRan).toBe(true);
      expect(method).not.toHaveBeenCalled();
    });
  });

  describe('post-invocation obligation failure', () => {
    test('whenOutputObligationFailsAfterMethodRanThenDenyWarnsOfSideEffects', async () => {
      // AP-10: the protected method already executed and its side effects
      // are not rolled back. Spring's deny message distinctly warns that
      // side effects may have occurred, unlike the pre-invocation deny.
      (pdpService.decideOnce as jest.Mock).mockResolvedValue(permitWithObligation);
      let sideEffectCount = 0;
      const failingOutput: ScopedHandler = {
        signal: 'output',
        priority: 0,
        shape: 'consumer',
        handler: () => {
          throw new Error('output redaction failed');
        },
      };
      const aspect = buildAspect(plannerWith([failingOutput]));
      const method = jest.fn().mockImplementation(async () => {
        sideEffectCount += 1;
        return { data: 'x' };
      });

      const error = await wrap(aspect, method)().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccessDeniedError);
      expect(sideEffectCount).toBe(1);
      expect((error as Error).message).toMatch(/side.effect/i);
    });
  });

  describe('void method output', () => {
    test('whenMethodReturnsVoidThenOutputDataHandlersAreSkipped', async () => {
      // CC-10: a void return fires the output signal empty, so Mappers and
      // Consumers are skipped and only Runners fire.
      (pdpService.decideOnce as jest.Mock).mockResolvedValue(permitWithObligation);
      let consumerInvoked = false;
      const outputConsumer: ScopedHandler = {
        signal: 'output',
        priority: 0,
        shape: 'consumer',
        handler: () => {
          consumerInvoked = true;
        },
      };
      const aspect = buildAspect(plannerWith([outputConsumer]));
      const method = jest.fn().mockResolvedValue(undefined);

      await wrap(aspect, method)();

      expect(consumerInvoked).toBe(false);
    });
  });
});
