import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom } from 'rxjs';
import { PostEnforceInterceptor } from '../lib/PostEnforceInterceptor';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import {
  createMockBundle,
  createMockExecutionContext,
  createMockCallHandler,
} from './test-helpers';

describe('PostEnforceInterceptor', () => {
  let reflector: Reflector;
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let interceptor: PostEnforceInterceptor;

  beforeEach(() => {
    reflector = new Reflector();
    pdpService = { decideOnce: jest.fn() };
    constraintService = {
      postEnforceBundleFor: jest.fn(),
      bestEffortBundleFor: jest.fn(),
    };
    interceptor = new PostEnforceInterceptor(
      reflector,
      pdpService as PdpService,
      constraintService as ConstraintEnforcementService,
    );
  });

  test('whenNoMetadataThenPassesThroughWithoutCallingPdp', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    const next = createMockCallHandler({ data: 'passthrough' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ data: 'passthrough' });
    expect(pdpService.decideOnce).not.toHaveBeenCalled();
  });

  test('whenPermitThenHandlerResultReturnedAndBundleLifecycleRuns', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle();
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'result' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ data: 'result' });
    expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalled();
  });

  test('whenDenyThenThrowsForbiddenExceptionButHandlerStillExecuted', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler();

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    await expect(lastValueFrom(result$)).rejects.toThrow(ForbiddenException);
    expect(next.handle).toHaveBeenCalled();
  });

  test('whenDenyWithOnDenyThenReturnsCustomResponse', async () => {
    const onDeny = jest.fn().mockReturnValue({ denied: true });
    jest.spyOn(reflector, 'get').mockReturnValue({ onDeny });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler();

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ denied: true });
    expect(onDeny).toHaveBeenCalled();
  });

  test.each([
    { decision: 'NOT_APPLICABLE', label: 'notApplicable' },
    { decision: 'INDETERMINATE', label: 'indeterminate' },
  ])('when$labelThenThrowsForbiddenException', async ({ decision }) => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler();

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    await expect(lastValueFrom(result$)).rejects.toThrow(ForbiddenException);
  });

  test('whenPermitWithConstraintsThenBundleTransformsResult', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'someObligation' }],
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn((v) => ({ ...v, transformed: true })),
    } as any);
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'original' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ data: 'original', transformed: true });
  });

  test('whenUnhandledObligationOnPermitWithOnDenyThenCallsOnDeny', async () => {
    const onDeny = jest.fn().mockReturnValue({ fallback: true });
    jest.spyOn(reflector, 'get').mockReturnValue({ onDeny });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    (constraintService.postEnforceBundleFor as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('unhandled');
    });
    const next = createMockCallHandler({ data: 'original' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ fallback: true });
    expect(onDeny).toHaveBeenCalled();
  });

  test('whenPermitWithResourceReplacementThenResponseReplaced', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      resource: { replaced: true },
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => ({ replaced: true })),
    } as any);
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'original' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ replaced: true });
  });

  test('whenReturnValueThenAvailableInSubscriptionCallbacks', async () => {
    let capturedSubscription: any;
    const resourceCallback = jest.fn((ctx) => ({
      type: 'record',
      data: ctx.returnValue,
    }));

    jest.spyOn(reflector, 'get').mockReturnValue({ resource: resourceCallback });
    (pdpService.decideOnce as jest.Mock).mockImplementation(async (sub) => {
      capturedSubscription = sub;
      return { decision: 'PERMIT' };
    });
    const bundle = createMockBundle();
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ id: 42, value: 'data' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    await lastValueFrom(result$);

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
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => { throw new Error('onNext failed'); }),
      handleAllOnErrorConstraints: jest.fn((e) => e),
    } as any);
    (constraintService.postEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'test' });

    const result$ = interceptor.intercept(createMockExecutionContext(), next);
    await expect(lastValueFrom(result$)).rejects.toThrow(ForbiddenException);
    expect(bundle.handleAllOnErrorConstraints).toHaveBeenCalled();
  });

  describe('DENY with obligations', () => {
    test('whenDenyWithObligationsThenBestEffortBundleRunsOnDecisionHandlers', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue({});
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'auditLog' }],
      });
      const bundle = createMockBundle();
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const next = createMockCallHandler({ data: 'result' });

      const result$ = interceptor.intercept(createMockExecutionContext(), next);
      await expect(lastValueFrom(result$)).rejects.toThrow(ForbiddenException);

      expect(constraintService.bestEffortBundleFor).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'DENY', obligations: [{ type: 'auditLog' }] }),
      );
      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalled();
    });

    test('whenDenyWithObligationsAndOnDenyThenBestEffortRunsThenOnDenyCalled', async () => {
      const onDeny = jest.fn().mockReturnValue({ denied: true });
      jest.spyOn(reflector, 'get').mockReturnValue({ onDeny });
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'auditLog' }],
      });
      const bundle = createMockBundle();
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const next = createMockCallHandler({ data: 'result' });

      const result$ = interceptor.intercept(createMockExecutionContext(), next);
      const result = await lastValueFrom(result$);

      expect(result).toEqual({ denied: true });
      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(onDeny).toHaveBeenCalled();
    });

    test('whenDenyWithBestEffortHandlerFailureThenStillDenies', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue({});
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'failing' }],
      });
      const bundle = createMockBundle({
        handleOnDecisionConstraints: jest.fn(() => { throw new Error('handler failed'); }),
      } as any);
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const next = createMockCallHandler({ data: 'result' });

      const result$ = interceptor.intercept(createMockExecutionContext(), next);
      await expect(lastValueFrom(result$)).rejects.toThrow(ForbiddenException);
      expect(next.handle).toHaveBeenCalled();
    });
  });
});
