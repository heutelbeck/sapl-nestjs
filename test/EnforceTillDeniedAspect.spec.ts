import { ForbiddenException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { EnforceTillDeniedAspect } from '../lib/EnforceTillDeniedAspect';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import { createMockStreamingBundle, createMockClsService } from './test-helpers';

describe('EnforceTillDeniedAspect', () => {
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let aspect: EnforceTillDeniedAspect;
  let clsMock: ReturnType<typeof createMockClsService>;
  let decisionSubject: Subject<any>;

  beforeEach(() => {
    decisionSubject = new Subject();
    pdpService = { decide: jest.fn().mockReturnValue(decisionSubject.asObservable()) };
    constraintService = {
      streamingBundleFor: jest.fn(),
      streamingBestEffortBundleFor: jest.fn(),
    };
    clsMock = createMockClsService();
    aspect = new EnforceTillDeniedAspect(
      pdpService as PdpService,
      clsMock as any,
      constraintService as ConstraintEnforcementService,
    );
  });

  afterEach(() => {
    decisionSubject.complete();
  });

  function wrapMethod(
    method: (...args: any[]) => any,
    metadata = {},
    methodName = 'testHandler',
    instance = { constructor: { name: 'TestController' } },
  ) {
    return aspect.wrap({ method, metadata, methodName, instance } as any);
  }

  describe('deferred method invocation', () => {
    test('whenNoPermitReceivedThenMethodNotCalled', () => {
      const method = jest.fn().mockReturnValue(new Subject().asObservable());
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);

      const wrapped = wrapMethod(method);
      wrapped().subscribe();

      decisionSubject.next({ decision: 'DENY' });
      expect(method).not.toHaveBeenCalled();
    });

    test('whenFirstPermitReceivedThenMethodCalledExactlyOnce', () => {
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);
      wrapped().subscribe();

      expect(method).not.toHaveBeenCalled();
      decisionSubject.next({ decision: 'PERMIT' });
      expect(method).toHaveBeenCalledTimes(1);
    });
  });

  describe('basic permit flow', () => {
    test('whenPermitThenSourceDataForwardedToSubscriber', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'a' });
      sourceSubject.next({ data: 'b' });

      expect(emissions).toEqual([{ data: 'a' }, { data: 'b' }]);
      done();
    });

    test('whenPermitWithConstraintsThenBundleTransformsData', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle({
        handleAllOnNextConstraints: jest.fn((v) => ({ ...v, transformed: true })),
      } as any);
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'original' });

      expect(emissions).toEqual([{ data: 'original', transformed: true }]);
      done();
    });

    test('whenSourceCompletesThenOutputCompletes', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        complete: () => {
          expect(bundle.handleOnCompleteConstraints).toHaveBeenCalled();
          done();
        },
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.complete();
    });

    test('whenSourceErrorsThenOutputErrors', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err.message).toBe('source error');
          done();
        },
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.error(new Error('source error'));
    });
  });

  describe('deny handling', () => {
    test('whenInitialDenyThenStreamTerminatesWithForbiddenException', (done) => {
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          done();
        },
      });

      decisionSubject.next({ decision: 'DENY' });
    });

    test('whenDenyAfterPermitThenStreamTerminatesWithForbiddenException', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: (err: any) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          expect(emissions).toEqual([{ data: 'before-deny' }]);
          done();
        },
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'before-deny' });
      decisionSubject.next({ decision: 'DENY' });
    });

    test('whenDenyWithOnStreamDenyCallbackThenCallbackReceivesDecisionAndSubscriber', (done) => {
      const onStreamDeny = jest.fn();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe({
        error: () => {
          expect(onStreamDeny).toHaveBeenCalledWith(
            { decision: 'DENY' },
            expect.objectContaining({ next: expect.any(Function) }),
          );
          done();
        },
      });

      decisionSubject.next({ decision: 'DENY' });
    });

    test('whenOnStreamDenyInjectsEventViaSubscriberThenEventEmittedBeforeTermination', (done) => {
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());
      const onStreamDeny = jest.fn((_decision: any, subscriber: any) => {
        subscriber.next({ type: 'ACCESS_DENIED' });
      });

      const wrapped = wrapMethod(method, { onStreamDeny });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: () => {
          expect(emissions).toEqual([{ type: 'ACCESS_DENIED' }]);
          done();
        },
      });

      decisionSubject.next({ decision: 'DENY' });
    });
  });

  describe('bundle hot-swapping', () => {
    test('whenNewPermitDecisionArrivesThenBundleRebuiltAndConstraintsUpdated', (done) => {
      const sourceSubject = new Subject();
      const bundle1 = createMockStreamingBundle({
        handleAllOnNextConstraints: jest.fn((v) => ({ ...v, version: 1 })),
      } as any);
      const bundle2 = createMockStreamingBundle({
        handleAllOnNextConstraints: jest.fn((v) => ({ ...v, version: 2 })),
      } as any);
      (constraintService.streamingBundleFor as jest.Mock)
        .mockReturnValueOnce(bundle1)
        .mockReturnValueOnce(bundle2);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'a' });

      decisionSubject.next({ decision: 'PERMIT', obligations: [{ type: 'new' }] });
      sourceSubject.next({ data: 'b' });

      expect(emissions).toEqual([
        { data: 'a', version: 1 },
        { data: 'b', version: 2 },
      ]);
      expect(bundle1.handleOnDecisionConstraints).toHaveBeenCalled();
      expect(bundle2.handleOnDecisionConstraints).toHaveBeenCalled();
      done();
    });
  });

  describe('obligation failures', () => {
    test('whenUnhandledObligationOnPermitThenTreatedAsDenyAndTerminates', (done) => {
      (constraintService.streamingBundleFor as jest.Mock).mockImplementation(() => {
        throw new ForbiddenException('unhandled obligation');
      });
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          done();
        },
      });

      decisionSubject.next({ decision: 'PERMIT', obligations: [{ type: 'unknown' }] });
    });

    test('whenOnDecisionHandlerThrowsThenTerminates', (done) => {
      const bundle = createMockStreamingBundle({
        handleOnDecisionConstraints: jest.fn(() => { throw new Error('handler failed'); }),
      } as any);
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          done();
        },
      });

      decisionSubject.next({ decision: 'PERMIT' });
    });

    test('whenOnNextHandlerThrowsThenTerminates', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle({
        handleAllOnNextConstraints: jest.fn(() => { throw new Error('onNext failed'); }),
      } as any);
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          done();
        },
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'trigger' });
    });
  });

  describe('best-effort on deny', () => {
    test('whenDenyWithObligationsThenBestEffortBundleRunsOnDecisionHandlers', (done) => {
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: () => {
          expect(bestEffortBundle.handleOnDecisionConstraints).toHaveBeenCalled();
          done();
        },
      });

      decisionSubject.next({ decision: 'DENY', obligations: [{ type: 'audit' }] });
    });

    test('whenBestEffortHandlerFailsThenStillTerminatesNormally', (done) => {
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockImplementation(() => {
        throw new Error('best effort failed');
      });
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          done();
        },
      });

      decisionSubject.next({ decision: 'DENY' });
    });
  });

  describe('lifecycle', () => {
    test('whenUnsubscribedThenPdpDecisionStreamUnsubscribed', () => {
      const method = jest.fn().mockReturnValue(new Subject().asObservable());
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);

      const wrapped = wrapMethod(method);
      const sub = wrapped().subscribe();

      decisionSubject.next({ decision: 'PERMIT' });
      sub.unsubscribe();

      expect(decisionSubject.observed).toBe(false);
    });

    test('whenUnsubscribedThenSourceStreamUnsubscribed', () => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const sub = wrapped().subscribe();

      decisionSubject.next({ decision: 'PERMIT' });
      expect(sourceSubject.observed).toBe(true);

      sub.unsubscribe();
      expect(sourceSubject.observed).toBe(false);
    });

    test('whenUnsubscribedThenOnCancelHandlersRun', () => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const sub = wrapped().subscribe();

      decisionSubject.next({ decision: 'PERMIT' });
      sub.unsubscribe();

      expect(bundle.handleOnCancelConstraints).toHaveBeenCalled();
    });

    test('whenSourceCompletesThenOnCompleteHandlersRun', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        complete: () => {
          expect(bundle.handleOnCompleteConstraints).toHaveBeenCalled();
          done();
        },
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.complete();
    });
  });

  describe('edge cases', () => {
    test('whenPdpDecisionStreamErrorsThenOutputErrors', (done) => {
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err.message).toBe('pdp stream error');
          done();
        },
      });

      decisionSubject.error(new Error('pdp stream error'));
    });
  });
});
