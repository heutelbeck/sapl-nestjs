import { ForbiddenException } from '@nestjs/common';
import { PostEnforceAspect } from '../lib/PostEnforceAspect';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import { createMockBundle, createMockClsService } from './test-helpers';

describe('PostEnforceAspect', () => {
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let aspect: PostEnforceAspect;
  let clsMock: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    pdpService = { decideOnce: jest.fn() };
    constraintService = {
      postEnforceBundleFor: jest.fn(),
      bestEffortBundleFor: jest.fn(),
    };
    clsMock = createMockClsService();
    aspect = new PostEnforceAspect(
      pdpService as PdpService,
      clsMock as any,
      constraintService as ConstraintEnforcementService,
    );
  });

  function wrapMethod(
    method: (...args: any[]) => any,
    metadata = {},
    methodName = 'testHandler',
    instance = { constructor: { name: 'TestController' } },
  ) {
    return aspect.wrap({ method, metadata, methodName, instance } as any);
  }

  test('whenPermitThenMethodResultReturnedAndBundleLifecycleRuns', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle();
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'result' });

    const wrapped = wrapMethod(method);
    const result = await wrapped();

    expect(result).toEqual({ data: 'result' });
    expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
    expect(method).toHaveBeenCalled();
  });

  test('whenDenyThenThrowsForbiddenExceptionButMethodStillExecuted', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
    expect(method).toHaveBeenCalled();
  });

  test('whenDenyWithOnDenyThenReturnsCustomResponse', async () => {
    const onDeny = jest.fn().mockReturnValue({ denied: true });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method, { onDeny });
    const result = await wrapped();

    expect(result).toEqual({ denied: true });
    expect(onDeny).toHaveBeenCalled();
  });

  test.each([
    { decision: 'NOT_APPLICABLE', label: 'notApplicable' },
    { decision: 'INDETERMINATE', label: 'indeterminate' },
  ])('when$labelThenThrowsForbiddenException', async ({ decision }) => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
  });

  test('whenPermitWithConstraintsThenBundleTransformsResult', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'someObligation' }],
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn((v) => ({ ...v, transformed: true })),
    } as any);
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'original' });

    const wrapped = wrapMethod(method);
    const result = await wrapped();

    expect(result).toEqual({ data: 'original', transformed: true });
  });

  test('whenUnhandledObligationOnPermitWithOnDenyThenCallsOnDeny', async () => {
    const onDeny = jest.fn().mockReturnValue({ fallback: true });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    (constraintService.postEnforceBundleFor as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('unhandled');
    });
    const method = jest.fn().mockResolvedValue({ data: 'original' });

    const wrapped = wrapMethod(method, { onDeny });
    const result = await wrapped();

    expect(result).toEqual({ fallback: true });
    expect(onDeny).toHaveBeenCalled();
  });

  test('whenPermitWithResourceReplacementThenResponseReplaced', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      resource: { replaced: true },
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => ({ replaced: true })),
    } as any);
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'original' });

    const wrapped = wrapMethod(method);
    const result = await wrapped();

    expect(result).toEqual({ replaced: true });
  });

  test('whenReturnValueThenAvailableInSubscriptionCallbacks', async () => {
    let capturedSubscription: any;
    const resourceCallback = jest.fn((ctx) => ({
      type: 'record',
      data: ctx.returnValue,
    }));

    (pdpService.decideOnce as jest.Mock).mockImplementation(async (sub) => {
      capturedSubscription = sub;
      return { decision: 'PERMIT' };
    });
    const bundle = createMockBundle();
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ id: 42, value: 'data' });

    const wrapped = wrapMethod(method, { resource: resourceCallback });
    await wrapped();

    expect(resourceCallback).toHaveBeenCalledWith(
      expect.objectContaining({ returnValue: { id: 42, value: 'data' } }),
    );
    expect(capturedSubscription).toEqual(expect.objectContaining({
      resource: { type: 'record', data: { id: 42, value: 'data' } },
      subject: expect.anything(),
      action: expect.anything(),
      environment: expect.anything(),
    }));
  });

  test('whenOnNextConstraintThrowsThenErrorHandlersRunBeforeDeny', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => { throw new Error('onNext failed'); }),
      handleAllOnErrorConstraints: jest.fn((e) => e),
    } as any);
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
    expect(bundle.handleAllOnErrorConstraints).toHaveBeenCalled();
  });

  describe('DENY with obligations', () => {
    test('whenDenyWithObligationsThenBestEffortBundleRunsOnDecisionHandlers', async () => {
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'auditLog' }],
      });
      const bundle = createMockBundle();
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockResolvedValue({ data: 'result' });

      const wrapped = wrapMethod(method);
      await expect(wrapped()).rejects.toThrow(ForbiddenException);

      expect(constraintService.bestEffortBundleFor).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'DENY', obligations: [{ type: 'auditLog' }] }),
      );
      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(method).toHaveBeenCalled();
    });

    test('whenDenyWithObligationsAndOnDenyThenBestEffortRunsThenOnDenyCalled', async () => {
      const onDeny = jest.fn().mockReturnValue({ denied: true });
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'auditLog' }],
      });
      const bundle = createMockBundle();
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockResolvedValue({ data: 'result' });

      const wrapped = wrapMethod(method, { onDeny });
      const result = await wrapped();

      expect(result).toEqual({ denied: true });
      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(onDeny).toHaveBeenCalled();
    });

    test('whenDenyWithBestEffortHandlerFailureThenStillDenies', async () => {
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'failing' }],
      });
      const bundle = createMockBundle({
        handleOnDecisionConstraints: jest.fn(() => { throw new Error('handler failed'); }),
      } as any);
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockResolvedValue({ data: 'result' });

      const wrapped = wrapMethod(method);
      await expect(wrapped()).rejects.toThrow(ForbiddenException);
      expect(method).toHaveBeenCalled();
    });
  });
});
