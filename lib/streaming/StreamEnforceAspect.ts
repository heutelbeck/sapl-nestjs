import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { Observable, finalize, tap } from 'rxjs';
import { EnforcementPlanner } from '../constraints/Planner';
import { EnforcementPlan } from '../constraints/Plan';
import type { SignalKind } from '../constraints/Signal';
import { PdpService } from '../pdp.service';
import { buildContext, buildSubscriptionFromContext } from '../SubscriptionBuilder';
import type { AuthorizationDecision } from '../types';
import { EnforcementPlan as MealyPlan, EnforcementResult, absentMaybe, presentMaybe } from './MealyMachine';
import { STREAM_ENFORCE_SYMBOL, StreamEnforceOptions } from './StreamEnforce';
import { createStreamingPipeline } from './StreamingPipeline';

const STREAM_SIGNALS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'decision',
  'output',
  'error',
  'subscribe',
  'cancel',
  'complete',
  'termination',
]);

@Aspect(STREAM_ENFORCE_SYMBOL)
export class StreamEnforceAspect implements LazyDecorator<any, StreamEnforceOptions> {
  constructor(
    private readonly pdpService: PdpService,
    private readonly cls: ClsService,
    private readonly planner: EnforcementPlanner,
  ) {}

  wrap({ method, metadata, methodName, instance }: WrapParams<any, StreamEnforceOptions>) {
    const className = (instance as { constructor: { name: string } }).constructor.name;
    const pauseRapDuringSuspend = metadata.pauseRapDuringSuspend ?? false;
    const signalTransitions = metadata.signalTransitions ?? false;

    return (...args: unknown[]): Observable<unknown> => {
      const context = buildContext(this.cls, methodName, className, args);
      const subscription = buildSubscriptionFromContext(metadata, context);
      const decisions = this.pdpService.decide(subscription);

      // The plan is per-decision; lifecycle signals fire against the most
      // recent plan. The subscribe signal handlers of the FIRST plan fire
      // when that plan is built (subscribe-time has already passed).
      let currentPlan: EnforcementPlan | null = null;
      let firstPlanApplied = false;

      const planner = (decision: AuthorizationDecision): MealyPlan => {
        currentPlan = this.planner.plan(decision, STREAM_SIGNALS);
        if (!firstPlanApplied) {
          firstPlanApplied = true;
          currentPlan.execute({ kind: 'subscribe' });
        }
        return this.adaptForFsm(currentPlan, decision);
      };

      const rapSupplier = (): Observable<unknown> =>
        (method as (...rapArgs: unknown[]) => Observable<unknown>).apply(instance, args);

      const pipeline$ = createStreamingPipeline({
        pauseRapDuringSuspend,
        decisions,
        planner,
        rapSupplier,
        signalTransitions,
      });

      return pipeline$.pipe(
        tap({
          error: (error: unknown) => {
            const asError = error instanceof Error ? error : new Error(String(error));
            currentPlan?.execute({ kind: 'error', value: asError });
          },
          complete: () => currentPlan?.execute({ kind: 'complete' }),
          unsubscribe: () => currentPlan?.execute({ kind: 'cancel' }),
        }),
        finalize(() => currentPlan?.execute({ kind: 'termination' })),
      );
    };
  }

  private adaptForFsm(plan: EnforcementPlan, decision: AuthorizationDecision): MealyPlan {
    return {
      enforceDecisionConstraints(): boolean {
        const result = plan.execute({ kind: 'decision', value: decision });
        return result.failureState;
      },
      executePerItem(payload: unknown): EnforcementResult<unknown> {
        const result = plan.execute({ kind: 'output', value: payload });
        if (result.failureState) {
          return { failureState: true, value: absentMaybe };
        }
        if (result.value.kind === 'absent') {
          return { failureState: false, value: absentMaybe };
        }
        const transformed = result.value.value;
        return transformed === null || transformed === undefined
          ? { failureState: false, value: absentMaybe }
          : { failureState: false, value: presentMaybe(transformed) };
      },
    };
  }
}
