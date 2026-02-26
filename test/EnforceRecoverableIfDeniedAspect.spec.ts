import { Subject } from 'rxjs';
import { EnforceRecoverableIfDeniedAspect } from '../lib/EnforceRecoverableIfDeniedAspect';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import { createMockStreamingBundle, createMockClsService } from './test-helpers';

describe('EnforceRecoverableIfDeniedAspect', () => {
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let aspect: EnforceRecoverableIfDeniedAspect;
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
    aspect = new EnforceRecoverableIfDeniedAspect(
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
  });

  describe('deny handling -- edge-triggered', () => {
    test('whenDenyAfterPermitThenOnStreamDenyFiredOnce', (done) => {
      const sourceSubject = new Subject();
      const onStreamDeny = jest.fn();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });

      expect(onStreamDeny).toHaveBeenCalledTimes(1);
      expect(onStreamDeny).toHaveBeenCalledWith(
        { decision: 'DENY' },
        expect.objectContaining({ next: expect.any(Function) }),
      );
      done();
    });

    test('whenRepeatedDenyDecisionsThenOnStreamDenyFiredOnlyOnFirstTransition', (done) => {
      const sourceSubject = new Subject();
      const onStreamDeny = jest.fn();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'NOT_APPLICABLE' });

      expect(onStreamDeny).toHaveBeenCalledTimes(1);
      done();
    });

    test('whenDenyThenDataDroppedSilently', (done) => {
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
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'before' });
      decisionSubject.next({ decision: 'DENY' });
      sourceSubject.next({ data: 'during-deny' });

      expect(emissions).toEqual([{ data: 'before' }]);
      done();
    });

    test('whenDenyThenStreamStaysAlive', () => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      let completed = false;
      let errored = false;

      wrapped().subscribe({
        complete: () => { completed = true; },
        error: () => { errored = true; },
      });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });

      expect(completed).toBe(false);
      expect(errored).toBe(false);
    });
  });

  describe('recovery -- edge-triggered', () => {
    test('whenRePermitAfterDenyThenOnStreamRecoverFiredOnce', (done) => {
      const sourceSubject = new Subject();
      const onStreamRecover = jest.fn();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method, { onStreamRecover });

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'PERMIT' });

      // Initial PERMIT does not fire onStreamRecover; only the recovery after DENY does
      expect(onStreamRecover).toHaveBeenCalledTimes(1);
      done();
    });

    test('whenRepeatedPermitDecisionsThenOnStreamRecoverNotFired', (done) => {
      const sourceSubject = new Subject();
      const onStreamRecover = jest.fn();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method, { onStreamRecover });

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'PERMIT' });

      // Initial PERMIT is silent; repeated PERMITs do not fire either
      expect(onStreamRecover).not.toHaveBeenCalled();
      done();
    });

    test('whenRecoveryThenDataResumes', (done) => {
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
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'a' });
      decisionSubject.next({ decision: 'DENY' });
      sourceSubject.next({ data: 'dropped' });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'b' });

      expect(emissions).toEqual([{ data: 'a' }, { data: 'b' }]);
      done();
    });
  });

  describe('subscriber injection', () => {
    test('whenOnStreamDenyInjectsEventViaSubscriberThenEventEmitted', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());
      const onStreamDeny = jest.fn((_decision: any, subscriber: any) => {
        subscriber.next({ type: 'ACCESS_SUSPENDED' });
      });

      const wrapped = wrapMethod(method, { onStreamDeny });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'before' });
      decisionSubject.next({ decision: 'DENY' });

      expect(emissions).toEqual([
        { data: 'before' },
        { type: 'ACCESS_SUSPENDED' },
      ]);
      done();
    });

    test('whenOnStreamRecoverInjectsEventAfterDenyThenEventEmitted', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());
      const onStreamRecover = jest.fn((_decision: any, subscriber: any) => {
        subscriber.next({ type: 'ACCESS_RESTORED' });
      });

      const wrapped = wrapMethod(method, { onStreamRecover });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      // Initial PERMIT does not fire onStreamRecover
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'a' });
      decisionSubject.next({ decision: 'DENY' });
      // Recovery fires onStreamRecover
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'b' });

      expect(emissions).toEqual([
        { data: 'a' },
        { type: 'ACCESS_RESTORED' },
        { data: 'b' },
      ]);
      done();
    });

    test('whenOnStreamDenyAndOnStreamRecoverBothInjectThenBothEventsEmitted', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());
      const onStreamDeny = jest.fn((_decision: any, subscriber: any) => {
        subscriber.next({ type: 'SUSPENDED' });
      });
      const onStreamRecover = jest.fn((_decision: any, subscriber: any) => {
        subscriber.next({ type: 'RESTORED' });
      });

      const wrapped = wrapMethod(method, { onStreamDeny, onStreamRecover });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'a' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'b' });

      // Initial PERMIT is silent; only transition callbacks fire
      expect(emissions).toEqual([
        { data: 'a' },
        { type: 'SUSPENDED' },
        { type: 'RESTORED' },
        { data: 'b' },
      ]);
      done();
    });

    test('whenInitialDenyWithInjectionThenSuspendedEventEmittedImmediately', (done) => {
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());
      const onStreamDeny = jest.fn((_decision: any, subscriber: any) => {
        subscriber.next({ type: 'ACCESS_SUSPENDED' });
      });

      const wrapped = wrapMethod(method, { onStreamDeny });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'DENY' });

      expect(emissions).toEqual([{ type: 'ACCESS_SUSPENDED' }]);
      done();
    });
  });

  describe('full lifecycle cycle', () => {
    test('whenPermitThenDenyThenPermitThenFullCycleWorks', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const onStreamDeny = jest.fn();
      const onStreamRecover = jest.fn();

      const wrapped = wrapMethod(method, { onStreamDeny, onStreamRecover });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ seq: 1 });
      decisionSubject.next({ decision: 'DENY' });
      sourceSubject.next({ seq: 2 });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ seq: 3 });

      // Initial PERMIT is silent; only the recovery after DENY fires onStreamRecover
      expect(onStreamRecover).toHaveBeenCalledTimes(1);
      expect(onStreamDeny).toHaveBeenCalledTimes(1);
      expect(emissions.filter((e) => e.seq)).toEqual([{ seq: 1 }, { seq: 3 }]);
      done();
    });
  });

  describe('bundle management', () => {
    test('whenPermitThenBundleBuiltAndOnDecisionHandlersRun', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'PERMIT' });

      expect(bundle.handleOnDecisionConstraints).toHaveBeenCalled();
      done();
    });

    test('whenDenyThenBestEffortBundleBuiltAndOnDecisionHandlersRun', (done) => {
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'DENY' });

      expect(bestEffortBundle.handleOnDecisionConstraints).toHaveBeenCalled();
      done();
    });
  });

  describe('lifecycle', () => {
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

    test('whenUnsubscribedThenBothStreamsUnsubscribed', () => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const sub = wrapped().subscribe();

      decisionSubject.next({ decision: 'PERMIT' });
      sub.unsubscribe();

      expect(decisionSubject.observed).toBe(false);
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
  });

  // SECURITY REQUIREMENT: Immediate Decision Enforcement
  //
  // When a new PDP decision arrives on a streaming subscription, enforcement
  // MUST take effect immediately -- not deferred to the next payload from the
  // protected source stream. Deferring enforcement to the next source emission
  // introduces an uncontrollable delay and creates a timing side-channel: an
  // observer can correlate the cessation of data with the source's emission
  // pattern, leaking information about a resource the user no longer has access
  // to. For EnforceRecoverableIfDenied, the onStreamDeny/onStreamRecover
  // callbacks MUST fire synchronously in the decision handler, and the
  // enforcement gate MUST close/open synchronously so that data emitted by the
  // source immediately after the decision change is correctly dropped/forwarded.
  describe('immediate decision enforcement', () => {
    test('whenDenyArrivesThenOnStreamDenyFiredBeforeAnySourceEmission', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      let denyCallbackTime = -1;
      let sourceEmitTime = -1;
      let counter = 0;
      const onStreamDeny = jest.fn(() => { denyCallbackTime = ++counter; });

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe({
        next: () => { if (sourceEmitTime < 0) sourceEmitTime = ++counter; },
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });

      // onStreamDeny must have fired synchronously, before any possible
      // source emission could set sourceEmitTime
      expect(denyCallbackTime).toBeGreaterThan(0);
      expect(onStreamDeny).toHaveBeenCalledTimes(1);
      done();
    });

    test('whenDenyArrivesThenEnforcementGateClosedSynchronously', (done) => {
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
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'before-deny' });
      decisionSubject.next({ decision: 'DENY' });

      // Data emitted immediately after DENY must be dropped
      sourceSubject.next({ data: 'immediately-after-deny' });

      expect(emissions).toEqual([{ data: 'before-deny' }]);
      done();
    });

    test('whenRePermitArrivesThenOnStreamRecoverFiredBeforeSourceEmission', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const events: string[] = [];
      const onStreamDeny = jest.fn();
      const onStreamRecover = jest.fn(() => { events.push('recover'); });

      const wrapped = wrapMethod(method, { onStreamDeny, onStreamRecover });

      wrapped().subscribe({
        next: () => { events.push('data'); },
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'PERMIT' });

      // Recovery callback must have fired synchronously before any data
      sourceSubject.next({ data: 'after-recovery' });

      expect(events).toEqual(['recover', 'data']);
      done();
    });
  });

  describe('initial state notifications', () => {
    test('whenInitialDenyThenOnStreamDenyFired', () => {
      const onStreamDeny = jest.fn();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe();

      decisionSubject.next({ decision: 'DENY' });

      expect(onStreamDeny).toHaveBeenCalledTimes(1);
      expect(onStreamDeny).toHaveBeenCalledWith(
        { decision: 'DENY' },
        expect.objectContaining({ next: expect.any(Function) }),
      );
    });

    test('whenInitialPermitThenOnStreamRecoverNotFired', () => {
      const onStreamRecover = jest.fn();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method, { onStreamRecover });

      wrapped().subscribe();

      decisionSubject.next({ decision: 'PERMIT' });

      expect(onStreamRecover).not.toHaveBeenCalled();
    });

    test('whenInitialDenyThenSubsequentDenyNotRefired', () => {
      const onStreamDeny = jest.fn();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe();

      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'NOT_APPLICABLE' });

      expect(onStreamDeny).toHaveBeenCalledTimes(1);
    });

    test('whenOnlyPermitNeverDenyThenOnStreamDenyNeverFired', () => {
      const sourceSubject = new Subject();
      const onStreamDeny = jest.fn();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny });

      wrapped().subscribe();

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'PERMIT' });

      expect(onStreamDeny).not.toHaveBeenCalled();
    });

    test('whenPdpStreamErrorsThenOutputErrors', (done) => {
      const method = jest.fn().mockReturnValue(new Subject().asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        error: (err: any) => {
          expect(err.message).toBe('pdp error');
          done();
        },
      });

      decisionSubject.error(new Error('pdp error'));
    });

    test('whenInitialDenyThenRecoveryThenFullCycleWorks', (done) => {
      const sourceSubject = new Subject();
      const onStreamDeny = jest.fn();
      const onStreamRecover = jest.fn();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method, { onStreamDeny, onStreamRecover });
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ seq: 1 });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ seq: 2 });

      expect(onStreamDeny).toHaveBeenCalledTimes(2);
      expect(onStreamRecover).toHaveBeenCalledTimes(2);
      expect(emissions.filter((e) => e.seq)).toEqual([{ seq: 1 }, { seq: 2 }]);
      done();
    });
  });
});
