import { Subject } from 'rxjs';
import { EnforceDropWhileDeniedAspect } from '../lib/EnforceDropWhileDeniedAspect';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';
import { createMockStreamingBundle, createMockClsService } from './test-helpers';

describe('EnforceDropWhileDeniedAspect', () => {
  let pdpService: Partial<PdpService>;
  let constraintService: Partial<ConstraintEnforcementService>;
  let aspect: EnforceDropWhileDeniedAspect;
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
    aspect = new EnforceDropWhileDeniedAspect(
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

  describe('deny handling -- silent drops', () => {
    test('whenInitialDenyThenSourceDataDroppedSilently', (done) => {
      const sourceSubject = new Subject();
      const bestEffortBundle = createMockStreamingBundle();
      const bundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
        error: done,
      });

      decisionSubject.next({ decision: 'DENY' });

      // Source won't be subscribed until PERMIT, but verify no emissions after PERMIT
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'after-permit' });

      expect(emissions).toEqual([{ data: 'after-permit' }]);
      done();
    });

    test('whenDenyAfterPermitThenSourceDataDroppedSilently', (done) => {
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
      sourceSubject.next({ data: 'during-deny' });

      expect(emissions).toEqual([{ data: 'before-deny' }]);
      done();
    });

    test('whenDenyThenStreamStaysAlive', () => {
      const sourceSubject = new Subject();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      let completed = false;
      let errored = false;

      wrapped().subscribe({
        complete: () => { completed = true; },
        error: () => { errored = true; },
      });

      decisionSubject.next({ decision: 'DENY' });

      expect(completed).toBe(false);
      expect(errored).toBe(false);
    });
  });

  describe('recovery', () => {
    test('whenDenyThenRePermitThenDataResumes', (done) => {
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
      sourceSubject.next({ data: 'b-dropped' });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ data: 'c' });

      expect(emissions).toEqual([{ data: 'a' }, { data: 'c' }]);
      done();
    });

    test('whenMultipleDenyPermitCyclesThenDataFlowsCorrectly', (done) => {
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
      sourceSubject.next({ seq: 1 });
      decisionSubject.next({ decision: 'DENY' });
      sourceSubject.next({ seq: 2 });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ seq: 3 });
      decisionSubject.next({ decision: 'DENY' });
      sourceSubject.next({ seq: 4 });
      decisionSubject.next({ decision: 'PERMIT' });
      sourceSubject.next({ seq: 5 });

      expect(emissions).toEqual([{ seq: 1 }, { seq: 3 }, { seq: 5 }]);
      done();
    });
  });

  describe('bundle management', () => {
    test('whenPermitAfterDenyThenNewBundleBuilt', (done) => {
      const sourceSubject = new Subject();
      const bundle1 = createMockStreamingBundle();
      const bundle2 = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock)
        .mockReturnValueOnce(bundle1)
        .mockReturnValueOnce(bundle2);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({ error: done });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'PERMIT' });

      expect(constraintService.streamingBundleFor).toHaveBeenCalledTimes(2);
      done();
    });
  });

  describe('lifecycle', () => {
    test('whenSourceCompletesDuringDenyThenOutputCompletes', (done) => {
      const sourceSubject = new Subject();
      const bundle = createMockStreamingBundle();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBundleFor as jest.Mock).mockReturnValue(bundle);
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);

      wrapped().subscribe({
        complete: () => done(),
        error: done,
      });

      decisionSubject.next({ decision: 'PERMIT' });
      decisionSubject.next({ decision: 'DENY' });
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

    test('whenSourceCompletesDuringPermitThenOnCompleteHandlersRun', (done) => {
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
    test('whenNeverPermittedThenNoDataEverEmitted', () => {
      const sourceSubject = new Subject();
      const bestEffortBundle = createMockStreamingBundle();
      (constraintService.streamingBestEffortBundleFor as jest.Mock).mockReturnValue(bestEffortBundle);
      const method = jest.fn().mockReturnValue(sourceSubject.asObservable());

      const wrapped = wrapMethod(method);
      const emissions: any[] = [];

      wrapped().subscribe({
        next: (v: any) => emissions.push(v),
      });

      decisionSubject.next({ decision: 'DENY' });
      decisionSubject.next({ decision: 'NOT_APPLICABLE' });

      expect(emissions).toEqual([]);
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
  });
});
