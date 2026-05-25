import { ForbiddenException } from '@nestjs/common';
import { PostEnforceAspect } from '../lib/PostEnforceAspect';
import { PdpService } from '../lib/pdp.service';
import { EnforcementPlanner } from '../lib/constraints/Planner';
import { createFakePlanner, createMockClsService, createMockTransactionAdapter } from './test-helpers';

describe('PostEnforceAspect', () => {
  let pdpService: Partial<PdpService>;
  let clsMock: ReturnType<typeof createMockClsService>;

  const buildAspect = (planner: EnforcementPlanner, txActive = false) =>
    new PostEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      planner,
      createMockTransactionAdapter(txActive) as any,
    );

  beforeEach(() => {
    pdpService = { decideOnce: jest.fn() };
    clsMock = createMockClsService();
  });

  function wrap(aspect: PostEnforceAspect, method: (...args: any[]) => any, metadata = {}) {
    return aspect.wrap({
      method,
      metadata,
      methodName: 'testHandler',
      instance: { constructor: { name: 'TestController' } },
    } as any);
  }

  test('whenPermitWithNoConstraintsThenMethodExecutesFirstAndReturnsValue', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const aspect = buildAspect(createFakePlanner());
    let methodInvokedBeforeDecide = false;
    const method = jest.fn().mockImplementation(async () => {
      methodInvokedBeforeDecide = (pdpService.decideOnce as jest.Mock).mock.calls.length === 0;
      return { data: 'x' };
    });

    const result = await wrap(aspect, method)();

    expect(result).toEqual({ data: 'x' });
    expect(methodInvokedBeforeDecide).toBe(true);
  });

  test('whenDenyThenThrowsForbiddenException', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const aspect = buildAspect(createFakePlanner());
    const method = jest.fn().mockResolvedValue({ data: 'x' });

    await expect(wrap(aspect, method)()).rejects.toThrow(ForbiddenException);
  });

  test('whenPermitWithOutputObligationThenResponseIsTransformed', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'transform' }],
    });
    const aspect = buildAspect(
      createFakePlanner({
        onOutput: (v) => ({ ...(v as object), redacted: true }),
      }),
    );
    const method = jest.fn().mockResolvedValue({ secret: 'foo', other: 'bar' });

    const result = await wrap(aspect, method)();

    expect(result).toEqual({ secret: 'foo', other: 'bar', redacted: true });
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

  test('whenUnresolvedObligationOnPermitThenThrows', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknown' }],
    });
    const aspect = buildAspect(createFakePlanner());
    const method = jest.fn().mockResolvedValue({ data: 'x' });

    await expect(wrap(aspect, method)()).rejects.toThrow(ForbiddenException);
  });

  test('whenTransactionalThenAdapterWrapsTheWholeFlow', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const txAdapter = createMockTransactionAdapter(true);
    const aspect = new PostEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      createFakePlanner(),
      txAdapter as any,
    );
    const method = jest.fn().mockResolvedValue({ data: 'x' });

    await wrap(aspect, method)();

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
