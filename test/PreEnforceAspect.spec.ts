import { ForbiddenException } from '@nestjs/common';
import { PreEnforceAspect } from '../lib/PreEnforceAspect';
import { PdpService } from '../lib/pdp.service';
import { EnforcementPlanner } from '../lib/constraints/Planner';
import { createFakePlanner, createMockClsService, createMockTransactionAdapter } from './test-helpers';

describe('PreEnforceAspect', () => {
  let pdpService: Partial<PdpService>;
  let clsMock: ReturnType<typeof createMockClsService>;

  const buildAspect = (planner: EnforcementPlanner, txActive = false) =>
    new PreEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      planner,
      createMockTransactionAdapter(txActive) as any,
    );

  beforeEach(() => {
    pdpService = { decideOnce: jest.fn() };
    clsMock = createMockClsService();
  });

  function wrap(aspect: PreEnforceAspect, method: (...args: any[]) => any, metadata = {}) {
    return aspect.wrap({
      method,
      metadata,
      methodName: 'testHandler',
      instance: { constructor: { name: 'TestController' } },
    } as any);
  }

  test('whenPermitWithNoConstraintsThenMethodExecutesAndReturnsValue', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const aspect = buildAspect(createFakePlanner());
    const method = jest.fn().mockResolvedValue({ data: 'success' });

    const result = await wrap(aspect, method)();

    expect(result).toEqual({ data: 'success' });
    expect(method).toHaveBeenCalled();
  });

  test('whenDenyThenThrowsForbiddenExceptionAndMethodNotCalled', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const aspect = buildAspect(createFakePlanner());
    const method = jest.fn();

    await expect(wrap(aspect, method)()).rejects.toThrow(ForbiddenException);
    expect(method).not.toHaveBeenCalled();
  });

  test('whenDeniedThenErrorMessageContainsNoPolicyInternals', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'DENY',
      obligations: [{ type: 'sensitiveObligationName' }],
    });
    const aspect = buildAspect(createFakePlanner());
    try {
      await wrap(aspect, jest.fn())();
      fail('Expected AccessDeniedError');
    } catch (error: any) {
      expect(error.message).not.toContain('sensitiveObligationName');
      expect(error.message).not.toMatch(/obligation|advice/i);
    }
  });

  test.each([{ decision: 'NOT_APPLICABLE' }, { decision: 'INDETERMINATE' }])(
    'when$decisionThenThrowsForbiddenException',
    async ({ decision }) => {
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision });
      const aspect = buildAspect(createFakePlanner());

      await expect(wrap(aspect, jest.fn())()).rejects.toThrow(ForbiddenException);
    },
  );

  test('whenPermitWithOutputObligationThenResponseIsTransformed', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'testObligation' }],
    });
    const aspect = buildAspect(
      createFakePlanner({
        onOutput: (v) => ({ ...(v as object), transformed: true }),
      }),
    );
    const method = jest.fn().mockResolvedValue({ data: 'original' });

    const result = await wrap(aspect, method)();

    expect(result).toEqual({ data: 'original', transformed: true });
  });

  test('whenUnresolvedObligationOnPermitThenThrowsForbiddenException', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    const aspect = buildAspect(createFakePlanner());
    const method = jest.fn();

    await expect(wrap(aspect, method)()).rejects.toThrow(ForbiddenException);
    expect(method).not.toHaveBeenCalled();
  });

  test('whenInputObligationMutatesArgsThenMethodReceivesModifiedArgs', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'reverseArgs' }],
    });
    const aspect = buildAspect(
      createFakePlanner({
        onInput: (args) => [...args].reverse(),
      }),
    );
    let received: unknown[] = [];
    const method = jest.fn().mockImplementation(async (...args: unknown[]) => {
      received = args;
      return { ok: true };
    });

    await wrap(aspect, method)('a', 'b', 'c');

    expect(received).toEqual(['c', 'b', 'a']);
  });

  test('whenInputHandlerObservesArgsThenMethodReceivesOriginalArgs', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'observe' }],
    });
    const observed: unknown[] = [];
    const aspect = buildAspect(
      createFakePlanner({
        onInput: (args) => {
          observed.push(...args);
          return undefined;
        },
      }),
    );
    const method = jest.fn().mockResolvedValue({ ok: true });

    await wrap(aspect, method)(1, 2);

    expect(observed).toEqual([1, 2]);
    expect(method).toHaveBeenCalledWith(1, 2);
  });

  test('whenOutputHandlerThrowsObligationFailureThenDeny', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'fail' }],
    });
    const aspect = buildAspect(
      createFakePlanner({
        onOutput: () => {
          throw new Error('output handler failed');
        },
      }),
    );
    const method = jest.fn().mockResolvedValue({ data: 'x' });

    await expect(wrap(aspect, method)()).rejects.toThrow(ForbiddenException);
  });

  test('whenMethodThrowsThenErrorHandlerCanMapTheError', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'mapError' }],
    });
    class CustomError extends Error {}
    const aspect = buildAspect(
      createFakePlanner({
        onError: (_e) => new CustomError('mapped'),
      }),
    );
    const method = jest.fn().mockRejectedValue(new Error('original'));

    await expect(wrap(aspect, method)()).rejects.toBeInstanceOf(CustomError);
  });

  test('whenTransactionalAndOutputObligationFailsThenTransactionAdapterIsUsed', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'fail' }],
    });
    const txAdapter = createMockTransactionAdapter(true);
    const aspect = new PreEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      createFakePlanner({
        onOutput: () => {
          throw new Error('fail');
        },
      }),
      txAdapter as any,
    );
    const method = jest.fn().mockResolvedValue({ data: 'x' });

    await expect(wrap(aspect, method)()).rejects.toThrow(ForbiddenException);
    expect(txAdapter.withTransaction).toHaveBeenCalled();
  });

  test('whenPermitWithResourceFieldThenSubstitutionOverridesMethodResult', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      resource: { substituted: true },
    });
    const aspect = buildAspect(createFakePlanner());
    const method = jest.fn().mockResolvedValue({ original: true });

    const result = await wrap(aspect, method)();

    expect(result).toEqual({ substituted: true });
  });
});
