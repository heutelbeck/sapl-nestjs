import { Subject } from 'rxjs';
import type { AuthorizationDecision } from '../../lib/types';
import { EnforcementPlan } from '../../lib/streaming/MealyMachine';
import { AccessDeniedError } from '../../lib/streaming/BoundarySignals';
import {
  StreamingPipelineConfig,
  classify,
  createStreamingPipeline,
} from '../../lib/streaming/StreamingPipeline';

const PERMIT: AuthorizationDecision = { decision: 'PERMIT' };

const passthroughPlan = (): EnforcementPlan => ({
  enforceDecisionConstraints: () => false,
  executePerItem: () => ({ failureState: false, value: { type: 'Absent' } as const }),
});

describe('PERMIT with failed decision-scoped enforcement -> terminal DENY', () => {
  test('whenClassifyCalledWithPermitAndFailedFlagThenProducesPdpDenyWithReason', () => {
    const plan = passthroughPlan();
    const event = classify(PERMIT, plan, true);
    if (event.type !== 'PdpDeny') throw new Error(`expected PdpDeny got ${event.type}`);
    expect(event.reason).toMatch(/decision-scoped/i);
    expect(event.decision).toBe(PERMIT);
  });

  test('whenPipelineSeesPermitWithFailedDecisionScopedEnforcementThenSubscriberErrorsWithPermitNotEnforceable', async () => {
    const pdp = new Subject<AuthorizationDecision>();
    const failingPlan: EnforcementPlan = {
      enforceDecisionConstraints: () => true,
      executePerItem: () => ({ failureState: false, value: { type: 'Absent' } as const }),
    };
    const config: StreamingPipelineConfig = {
      pauseRapDuringSuspend: false,
      decisions: pdp.asObservable(),
      planner: () => failingPlan,
      rapSupplier: () => new Subject<unknown>().asObservable(),
      signalTransitions: false,
    };
    const stream = createStreamingPipeline(config);

    const errorPromise = new Promise<unknown>((resolve) => {
      stream.subscribe({
        next: () => undefined,
        error: resolve,
        complete: () => resolve(new Error('unexpected complete')),
      });
    });
    pdp.next(PERMIT);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(AccessDeniedError);
  });

  test('whenPermitCarriesResourceAndDecisionScopedEnforcementFailsThenExceptionCarriesNoSensitiveFields', async () => {
    const permitWithResource: AuthorizationDecision = {
      decision: 'PERMIT',
      resource: { ssn: '123-45-6789' },
      obligations: [{ type: 'audit', detail: 'sensitive' }],
    };
    const pdp = new Subject<AuthorizationDecision>();
    const config: StreamingPipelineConfig = {
      pauseRapDuringSuspend: false,
      decisions: pdp.asObservable(),
      planner: () => ({
        enforceDecisionConstraints: () => true,
        executePerItem: () => ({ failureState: false, value: { type: 'Absent' } as const }),
      }),
      rapSupplier: () => new Subject<unknown>().asObservable(),
      signalTransitions: false,
    };
    const stream = createStreamingPipeline(config);
    const errorPromise = new Promise<unknown>((resolve) => {
      stream.subscribe({
        next: () => undefined,
        error: resolve,
        complete: () => resolve(new Error('unexpected complete')),
      });
    });
    pdp.next(permitWithResource);
    const error = (await errorPromise) as AccessDeniedError;

    const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialised).not.toMatch(/123-45-6789/);
    expect(serialised).not.toMatch(/sensitive/);
  });
});
