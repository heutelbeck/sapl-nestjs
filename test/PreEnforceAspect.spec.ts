import { ForbiddenException } from '@nestjs/common';
import { PreEnforceAspect } from '../lib/PreEnforceAspect';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import { createMockBundle, createMockClsService } from './test-helpers';

describe('PreEnforceAspect', () => {
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let aspect: PreEnforceAspect;
  let clsMock: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    pdpService = { decideOnce: jest.fn() };
    constraintService = {
      preEnforceBundleFor: jest.fn(),
      bestEffortBundleFor: jest.fn(),
    };
    clsMock = createMockClsService();
    aspect = new PreEnforceAspect(
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

  test('whenPermitWithNoConstraintsThenMethodExecutesAndBundleLifecycleRuns', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle();
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'success' });

    const wrapped = wrapMethod(method);
    const result = await wrapped();

    expect(result).toEqual({ data: 'success' });
    expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
    expect(bundle.handleMethodInvocationHandlers).toHaveBeenCalled();
    expect(method).toHaveBeenCalled();
  });

  test('whenDenyThenThrowsForbiddenExceptionAndMethodNotCalled', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn();

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
    expect(method).not.toHaveBeenCalled();
  });

  test('whenDenyWithOnDenyThenReturnsCustomResponseAndMethodNotCalled', async () => {
    const onDeny = jest.fn().mockReturnValue({ error: 'denied' });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn();

    const wrapped = wrapMethod(method, { onDeny });
    const result = await wrapped();

    expect(result).toEqual({ error: 'denied' });
    expect(onDeny).toHaveBeenCalled();
    expect(method).not.toHaveBeenCalled();
  });

  test.each([
    { decision: 'NOT_APPLICABLE', label: 'notApplicable' },
    { decision: 'INDETERMINATE', label: 'indeterminate' },
  ])('when$labelThenThrowsForbiddenException', async ({ decision }) => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision });
    const bundle = createMockBundle();
    (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn();

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
    expect(method).not.toHaveBeenCalled();
  });

  test('whenPermitWithObligationsThenBundleTransformsResponse', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'testObligation' }],
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn((v) => ({ ...v, transformed: true })),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'original' });

    const wrapped = wrapMethod(method);
    const result = await wrapped();

    expect(result).toEqual({ data: 'original', transformed: true });
  });

  test('whenUnhandledObligationOnPermitThenThrowsForbiddenException', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    (constraintService.preEnforceBundleFor as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('unhandled');
    });
    const method = jest.fn();

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
    expect(method).not.toHaveBeenCalled();
  });

  test('whenUnhandledObligationOnPermitWithOnDenyThenCallsOnDeny', async () => {
    const onDeny = jest.fn().mockReturnValue({ fallback: true });
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      obligations: [{ type: 'unknownObligation' }],
    });
    (constraintService.preEnforceBundleFor as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('unhandled');
    });
    const method = jest.fn();

    const wrapped = wrapMethod(method, { onDeny });
    const result = await wrapped();

    expect(result).toEqual({ fallback: true });
    expect(onDeny).toHaveBeenCalled();
    expect(method).not.toHaveBeenCalled();
  });

  test('whenMethodInvocationHandlerThenReceivesMethodInvocationContext', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle();
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await wrapped('arg1', 'arg2');

    expect(bundle.handleMethodInvocationHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          user: expect.anything(),
          method: 'GET',
          params: expect.any(Object),
        }),
        args: ['arg1', 'arg2'],
        methodName: 'testHandler',
        className: 'TestController',
      }),
    );
  });

  test('whenMethodInvocationHandlerMutatesRequestThenAspectSeesChanges', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });

    const bundle = createMockBundle({
      handleMethodInvocationHandlers: jest.fn((context) => {
        context.request.body = { injected: true };
        context.request.params.id = 'forced-id';
      }),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await wrapped();

    expect(clsMock.request.body).toEqual({ injected: true });
    expect(clsMock.request.params.id).toBe('forced-id');
  });

  test('whenMethodInvocationHandlerMutatesArgsThenMethodReceivesModifiedArgs', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });

    const bundle = createMockBundle({
      handleMethodInvocationHandlers: jest.fn((context) => {
        context.args[0] = 'sanitized';
      }),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await wrapped('raw-input', 'other');

    expect(method).toHaveBeenCalledWith('sanitized', 'other');
  });

  test('whenPermitWithResourceReplacementThenResponseReplaced', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({
      decision: 'PERMIT',
      resource: { replaced: true },
    });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => ({ replaced: true })),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'original' });

    const wrapped = wrapMethod(method);
    const result = await wrapped();

    expect(result).toEqual({ replaced: true });
  });

  test('whenAsyncOnNextConstraintThrowsThenDenied', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => { throw new Error('onNext failed'); }),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockResolvedValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
  });

  test('whenSyncOnNextConstraintThrowsThenDenied', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const bundle = createMockBundle({
      handleAllOnNextConstraints: jest.fn(() => { throw new Error('onNext failed'); }),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockReturnValue({ data: 'test' });

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toThrow(ForbiddenException);
  });

  test('whenSyncMethodThrowsThenErrorHandlersRunAndMappedErrorPropagates', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const mappedError = new Error('mapped');
    const bundle = createMockBundle({
      handleAllOnErrorConstraints: jest.fn(() => mappedError),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockImplementation(() => { throw new Error('method failed'); });

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toBe(mappedError);
    expect(bundle.handleAllOnErrorConstraints).toHaveBeenCalled();
  });

  test('whenAsyncMethodRejectsThenErrorHandlersRunAndMappedErrorPropagates', async () => {
    (pdpService.decideOnce as jest.Mock).mockResolvedValue({ decision: 'PERMIT' });
    const mappedError = new Error('mapped');
    const bundle = createMockBundle({
      handleAllOnErrorConstraints: jest.fn(() => mappedError),
    } as any);
    (constraintService.preEnforceBundleFor as jest.Mock).mockReturnValue(bundle);
    const method = jest.fn().mockRejectedValue(new Error('method failed'));

    const wrapped = wrapMethod(method);
    await expect(wrapped()).rejects.toBe(mappedError);
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
      const method = jest.fn();

      const wrapped = wrapMethod(method);
      await expect(wrapped()).rejects.toThrow(ForbiddenException);

      expect(constraintService.bestEffortBundleFor).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'DENY', obligations: [{ type: 'auditLog' }] }),
      );
      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(method).not.toHaveBeenCalled();
    });

    test('whenDenyWithObligationsAndOnDenyThenBestEffortRunsThenOnDenyCalled', async () => {
      const onDeny = jest.fn().mockReturnValue({ denied: true });
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'auditLog' }],
      });
      const bundle = createMockBundle();
      (constraintService.bestEffortBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn();

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
      const method = jest.fn();

      const wrapped = wrapMethod(method);
      await expect(wrapped()).rejects.toThrow(ForbiddenException);
      expect(method).not.toHaveBeenCalled();
    });

    test('whenDenyWithUnhandledObligationThenBestEffortBundleFailsGracefully', async () => {
      (pdpService.decideOnce as jest.Mock).mockResolvedValue({
        decision: 'DENY',
        obligations: [{ type: 'unknown' }],
      });
      (constraintService.bestEffortBundleFor as jest.Mock).mockImplementation(() => {
        throw new Error('should not happen but gracefully handled');
      });
      const method = jest.fn();

      const wrapped = wrapMethod(method);
      await expect(wrapped()).rejects.toThrow(ForbiddenException);
      expect(method).not.toHaveBeenCalled();
    });
  });
});
