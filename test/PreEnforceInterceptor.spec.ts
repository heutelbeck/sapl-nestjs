import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom } from 'rxjs';
import { PreEnforceInterceptor } from '../lib/PreEnforceInterceptor';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import {
  createMockBundle,
  createMockExecutionContext,
  createMockCallHandler,
} from './test-helpers';

describe('PreEnforceInterceptor', () => {
  let reflector: Reflector;
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let interceptor: PreEnforceInterceptor;

  beforeEach(() => {
    reflector = new Reflector();
    pdpService = { decideOnce: jest.fn() };
    constraintService = {
      preEnforceBundleFor: jest.fn(),
      bestEffortBundleFor: jest.fn(),
    };
    interceptor = new PreEnforceInterceptor(
      reflector,
      pdpService as PdpService,
      constraintService as ConstraintEnforcementService,
    );
  });

  test('whenNoMetadataThenPassesThroughWithoutCallingPdp', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    const next = createMockCallHandler({ data: 'passthrough' });

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ data: 'passthrough' });
    expect(pdpService.decideOnce).not.toHaveBeenCalled();
  });

  test('whenPermitWithNoConstraintsThenHandlerExecutesAndBundleLifecycleRuns', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle();
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'success' });

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ data: 'success' });
    expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
    expect(bundle.handleMethodInvocationHandlers).toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalled();
  });

  test('whenDenyThenThrowsForbiddenExceptionAndHandlerNotCalled', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler();

    await expect(interceptor.intercept(createMockExecutionContext(), next))
      .rejects.toThrow(ForbiddenException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  test('whenDenyWithOnDenyThenReturnsCustomResponseAndHandlerNotCalled', async () => {
    const onDeny = jest.fn().mockReturnValue({ error: 'denied' });
    jest.spyOn(reflector, 'get').mockReturnValue({ onDeny });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler();

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ error: 'denied' });
    expect(onDeny).toHaveBeenCalled();
    expect(next.handle).not.toHaveBeenCalled();
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

    await expect(interceptor.intercept(createMockExecutionContext(), next))
      .rejects.toThrow(ForbiddenException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  test('whenPermitWithObligationsThenBundleTransformsResponse', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'testObligation' }],
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn((v) => ({ ...v, transformed: true })),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'original' });

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ data: 'original', transformed: true });
  });

  test('whenUnhandledObligationOnPermitThenThrowsForbiddenException', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    (constraintService.preEnforceBundleFor as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('unhandled');
    });
    const next = createMockCallHandler();

    await expect(interceptor.intercept(createMockExecutionContext(), next))
      .rejects.toThrow(ForbiddenException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  test('whenUnhandledObligationOnPermitWithOnDenyThenCallsOnDeny', async () => {
    const onDeny = jest.fn().mockReturnValue({ fallback: true });
    jest.spyOn(reflector, 'get').mockReturnValue({ onDeny });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    (constraintService.preEnforceBundleFor as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('unhandled');
    });
    const next = createMockCallHandler();

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ fallback: true });
    expect(onDeny).toHaveBeenCalled();
    expect(next.handle).not.toHaveBeenCalled();
  });

  test('whenMethodInvocationHandlerThenReceivesRequestObject', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle();
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'test' });

    await interceptor.intercept(createMockExecutionContext(), next);

    expect(bundle.handleMethodInvocationHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.anything(),
        method: 'GET',
        params: expect.any(Object),
        body: undefined,
        headers: expect.any(Object),
      }),
    );
  });

  test('whenMethodInvocationHandlerMutatesRequestThenHandlerSeesChanges', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });

    const capturedRequest: any[] = [];
    const bundle = createMockBundle({
      handleMethodInvocationHandlers: jest.fn((request) => {
        request.body = { injected: true };
        request.params.id = 'forced-id';
        capturedRequest.push(request);
      }),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'test' });
    const context = createMockExecutionContext();

    await interceptor.intercept(context, next);

    const request = context.switchToHttp().getRequest();
    expect(request.body).toEqual({ injected: true });
    expect(request.params.id).toBe('forced-id');
    expect(capturedRequest[0]).toBe(request);
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
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'original' });

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    const result = await lastValueFrom(result$);

    expect(result).toEqual({ replaced: true });
  });

  test('whenOnNextConstraintThrowsThenErrorHandlersRun', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({});
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const mappedError = new Error('mapped');
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => { throw new Error('onNext failed'); }),
      handleAllOnErrorConstraints: jest.fn(() => mappedError),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const next = createMockCallHandler({ data: 'test' });

    const result$ = await interceptor.intercept(createMockExecutionContext(), next);
    await expect(lastValueFrom(result$)).rejects.toBe(mappedError);
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
      const next = createMockCallHandler();

      await expect(interceptor.intercept(createMockExecutionContext(), next))
        .rejects.toThrow(ForbiddenException);

      expect(constraintService.bestEffortBundleFor).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'DENY', obligations: [{ type: 'auditLog' }] }),
      );
      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(next.handle).not.toHaveBeenCalled();
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
      const next = createMockCallHandler();

      const result$ = await interceptor.intercept(createMockExecutionContext(), next);
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
      const next = createMockCallHandler();

      await expect(interceptor.intercept(createMockExecutionContext(), next))
        .rejects.toThrow(ForbiddenException);
      expect(next.handle).not.toHaveBeenCalled();
    });

    test('whenDenyWithUnhandledObligationThenBestEffortBundleFailsGracefully', async () => {
      jest.spyOn(reflector, 'get').mockReturnValue({});
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'unknown' }],
      });
      (constraintService.bestEffortBundleFor as jest.Mock).mockImplementation(() => {
        throw new Error('should not happen but gracefully handled');
      });
      const next = createMockCallHandler();

      await expect(interceptor.intercept(createMockExecutionContext(), next))
        .rejects.toThrow(ForbiddenException);
      expect(next.handle).not.toHaveBeenCalled();
    });
  });
});
