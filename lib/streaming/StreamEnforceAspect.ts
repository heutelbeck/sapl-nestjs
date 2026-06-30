import { Aspect, LazyDecorator, WrapParams } from '@toss/nestjs-aop';
import { ClsService } from 'nestjs-cls';
import { Observable, finalize, tap } from 'rxjs';
import { EnforcementPlanner } from '../constraints/Planner';
import { EnforcementPlan } from '../constraints/Plan';
import type { Signal, SignalKind } from '../constraints/Signal';
import { PdpService } from '../pdp.service';
import { buildContext, buildSubscriptionFromContext } from '../SubscriptionBuilder';
import type { AuthorizationDecision } from '../types';
import { AccessDeniedError, EnforcementPlan as MealyPlan, EnforcementResult, absentMaybe, presentMaybe } from './MealyMachine';
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
        let subscribeDenied = false;
        if (!firstPlanApplied) {
          firstPlanApplied = true;
          // The subscribe signal gates before any data flows: an obligation
          // failure here denies the stream rather than being swallowed.
          subscribeDenied = currentPlan.execute({ kind: 'subscribe' }).failureState;
        }
        return this.adaptForFsm(currentPlan, decision, subscribeDenied);
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
            this.enforceSignalOrThrow(currentPlan, { kind: 'error', value: asError });
          },
          complete: () => this.enforceSignalOrThrow(currentPlan, { kind: 'complete' }),
          unsubscribe: () => this.enforceSignalOrThrow(currentPlan, { kind: 'cancel' }),
        }),
        finalize(() => this.enforceSignalOrThrow(currentPlan, { kind: 'termination' })),
      );
    };
  }

  /**
   * Discharges a void/self-contained lifecycle signal and raises an
   * at-signal AccessDeniedError when an obligation handler failed,
   * mirroring Spring EnforcementPlan.enforceConstraintsOrThrow.
   */
  private enforceSignalOrThrow(plan: EnforcementPlan | null, signal: Signal): void {
    if (plan !== null && plan.execute(signal).failureState) {
      throw new AccessDeniedError(`Access Denied. An obligation handler failed during ${signal.kind} enforcement.`);
    }
  }

  private adaptForFsm(plan: EnforcementPlan, decision: AuthorizationDecision, subscribeDenied: boolean): MealyPlan {
    return {
      enforceDecisionConstraints(): boolean {
        const result = plan.execute({ kind: 'decision', value: decision });
        return result.failureState || subscribeDenied;
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
